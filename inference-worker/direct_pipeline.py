"""Optional batched direct-slide processing using frozen STEGASUS experts.
Resume the identical command; committed coordinates, scores and features are cached.
"""
import argparse
from contextlib import ExitStack, closing
import sys
import time
import hashlib
import json
from pathlib import Path
import sqlite3

import numpy as np
import torch
import timm
from PIL import Image
from torchvision import transforms as T
from timm.data import resolve_model_data_config
import openslide

sys.path.insert(0, str(Path(__file__).resolve().parent / 'frozen'))
from patch_batches import read_patch, commit_batch
from spatial import SpatialGraphExpert, adjacency
from reliable_ensemble import predict, NAMES

ROOT = Path(__file__).resolve().parent

def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as f:
        for block in iter(lambda: f.read(1024*1024), b''):
            h.update(block)
    return h.hexdigest()

def run(resources):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--slide', type=Path, required=True)
    parser.add_argument('--run', type=Path, default=ROOT/'runs'/'20261030_234916_956062')
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--mpp-x', type=float)
    parser.add_argument('--mpp-y', type=float)
    parser.add_argument('--target-mpp', type=float, default=.972)
    parser.add_argument('--min-tissue', type=float, default=.20)
    parser.add_argument('--max-graph-nodes', type=int, default=20000)
    parser.add_argument('--batch-size', type=int, default=8)
    args = parser.parse_args()
    if args.target_mpp <= 0 or not 0 <= args.min_tissue <= 1 or args.max_graph_nodes < 1 or not 1 <= args.batch_size <= 256:
        parser.error('Invalid scale, tissue fraction, or node limit')
    args.slide = args.slide.resolve()
    args.run = args.run.resolve()
    args.output.mkdir(parents=True, exist_ok=True)
    # OS-level lock releases on interruption; never use two writers on one cache.
    lock = resources.enter_context((args.output/'writer.lock').open('a+b'))
    lock.seek(0)
    if lock.read(1) == b'':
        lock.write(b'0'); lock.flush()
    lock.seek(0)
    import msvcrt
    msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
    slide = resources.enter_context(openslide.OpenSlide(str(args.slide)))
    mx = args.mpp_x or float(slide.properties.get(openslide.PROPERTY_NAME_MPP_X, 'nan'))
    my = args.mpp_y or float(slide.properties.get(openslide.PROPERTY_NAME_MPP_Y, 'nan'))
    if not np.isfinite([mx,my]).all() or min(mx,my)<=0:
        raise ValueError('Missing physical scale. Supply verified --mpp-x and --mpp-y; do not guess.')
    size = (max(1,round(96*args.target_mpp/mx)), max(1,round(96*args.target_mpp/my)))
    level = slide.get_best_level_for_downsample(min(size)/96)
    ds = slide.level_downsamples[level]
    region = tuple(max(1,round(s/ds)) for s in size)
    files = [args.run/f'{n}.pt' for n in NAMES[:3]] + [args.run/'spatial_graph_expert.pt', args.run/'reliability_candidate'/'ensemble.joblib']
    signature = dict(slide_sha256=digest(args.slide), models={str(p.name):digest(p) for p in files},
        mpp=[mx,my], target_mpp=args.target_mpp, min_tissue=args.min_tissue,
        tile_size_level0=size, read_level=level, graph_limit=args.max_graph_nodes,
        preprocessing='RGB/no-ICC-conversion; model normalization; 96px; HSV saturation>20/value<245', version=2,
        pipeline='direct-batched-v1', batch_size=args.batch_size,
        implementation={p.name:digest(p) for p in [Path(__file__),ROOT/'patch_batches.py',ROOT/'frozen'/'spatial.py',ROOT/'frozen'/'reliable_ensemble.py']})
    manifest = args.output/'manifest.json'
    if manifest.exists() and json.loads(manifest.read_text()) != json.loads(json.dumps(signature)):
        raise RuntimeError('Input/settings/model changed. Use a new output folder.')
    manifest.write_text(json.dumps(signature,indent=2))
    device = 'cuda' if torch.cuda.is_available() else 'cpu'
    torch.set_num_threads(4)
    models, transforms = [], []
    for name in NAMES[:3]:
        model = timm.create_model(name, pretrained=False, num_classes=1).eval()
        model.load_state_dict(torch.load(args.run/f'{name}.pt',map_location='cpu',weights_only=False)['model'])
        cfg = resolve_model_data_config(model)
        transforms.append(T.Compose([T.ToTensor(),T.Normalize(cfg['mean'],cfg['std'])]))
        models.append(model.to(device))
    print(f'Direct pipeline ready: device={device}, batch_size={args.batch_size}',flush=True)
    db = resources.enter_context(closing(sqlite3.connect(args.output/'tiles.sqlite')))
    db.execute('CREATE TABLE IF NOT EXISTS tiles (x INTEGER,y INTEGER,tissue REAL,p0 REAL,p1 REAL,p2 REAL,feature BLOB,PRIMARY KEY(x,y))')
    completed = set(db.execute('SELECT x,y FROM tiles'))
    width,height = slide.dimensions
    total = ((width+size[0]-1)//size[0])*((height+size[1]-1)//size[1])
    started = time.monotonic()
    pending = []
    processed = len(completed)
    for y in range(0,height,size[1]):
        for x in range(0,width,size[0]):
            if (x,y) in completed:
                continue
            rgb, fraction = read_patch(slide,x,y,level,region)
            pending.append((x,y,fraction,rgb if fraction >= args.min_tissue else None))
            if len(pending) >= args.batch_size:
                processed += commit_batch(db,pending,models,transforms,device)
                pending.clear()
                if processed // 100 != (processed-args.batch_size) // 100:
                    print(f'{processed}/{total} grid patches cached; device={device}; elapsed={time.monotonic()-started:.1f}s',flush=True)
    if pending:
        processed += commit_batch(db,pending,models,transforms,device)
    models.clear()
    if device == 'cuda':
        torch.cuda.empty_cache()
    print(f'Patch processing complete: {processed}/{total}; graph aggregation next',flush=True)
    count = db.execute('SELECT COUNT(*) FROM tiles WHERE feature IS NOT NULL').fetchone()[0]
    if not count:
        raise RuntimeError('No tissue accepted. Review scale and tissue-mask settings; no score produced.')
    if count > args.max_graph_nodes:
        raise RuntimeError(f'{count} tissue nodes exceed graph limit {args.max_graph_nodes}. Tiles preserved. No silent subsampling or slide score. A larger-memory/hierarchical graph implementation is needed.')
    rows = list(db.execute('SELECT x,y,tissue,p0,p1,p2,feature FROM tiles WHERE feature IS NOT NULL ORDER BY y,x'))
    coords = np.array([[r[0],r[1]] for r in rows],dtype=float)
    features = torch.from_numpy(np.stack([np.frombuffer(r[6],dtype='float32') for r in rows]))
    checkpoint = torch.load(args.run/'spatial_graph_expert.pt',map_location='cpu',weights_only=False)
    graph = SpatialGraphExpert(checkpoint['feature_dim']).eval()
    graph.load_state_dict(checkpoint['model'])
    # CPU sparse graph avoids exhausting the laptop GPU; exact original k=8 policy.
    with torch.inference_mode():
        graph_probability = float(graph(features,adjacency(coords)).sigmoid().item())
    patch_p = np.array([r[3:6] for r in rows])
    base = np.r_[patch_p.max(axis=0),graph_probability][None,:]
    p,decision = predict(args.run,base)
    result = dict(status='exploratory_WSI_domain_shift_not_clinically_validated',
        tissue_tiles=count, grid_tiles=total, accepted_grid_fraction=count/total,
        quality_control='background heuristic only; blur/fold/pen/OOD checks not implemented',
        base_order=NAMES, base_scores=base[0].tolist(), ensemble_score=float(p[0]),
        research_threshold_flag=bool(decision[0]), requires_human_review=True,
        caution='A negative flag does not rule out metastasis. PCam calibration may not transfer to full WSIs.')
    (args.output/'result.json').write_text(json.dumps(result,indent=2))
    import csv
    with (args.output/'patch_predictions.csv').open('w',newline='') as f:
        writer=csv.writer(f); writer.writerow(['x_level0','y_level0','tissue_fraction',*NAMES[:3]])
        writer.writerows(r[:6] for r in rows)
    thumb=slide.get_thumbnail((1600,1600)).convert('RGB')
    thumb.save(args.output/'thumbnail.png')
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    fig,ax=plt.subplots(figsize=(10,8))
    ax.imshow(thumb,extent=(0,width,height,0))
    dots=ax.scatter(coords[:,0]+size[0]/2,coords[:,1]+size[1]/2,c=patch_p[:,2],vmin=0,vmax=1,cmap='turbo',s=5,alpha=.6)
    fig.colorbar(dots,ax=ax,label='ResNet50 patch score (not graph attention or tumor segmentation)')
    ax.set_title('Exploratory WSI tissue-patch map'); ax.set_axis_off()
    fig.savefig(args.output/'heatmap.png',dpi=160,bbox_inches='tight'); plt.close(fig)
    print(json.dumps(result,indent=2))
    # ExitStack also closes the database, slide and writer lock on failures.

def main():
    with ExitStack() as resources:
        run(resources)

if __name__=='__main__':
    try:
        main()
    except KeyboardInterrupt:
        print('\nPaused. Completed tiles are saved. Rerun the identical command to resume.')
