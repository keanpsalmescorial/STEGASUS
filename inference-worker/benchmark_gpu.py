"""Read-only real-slide sample comparison. Never accesses the Studio queue."""
import argparse
import json
from pathlib import Path
import sqlite3
import sys
import time
import numpy as np
import openslide
import torch
import timm
from torchvision import transforms as T
from timm.data import resolve_model_data_config
from patch_batches import infer_batch, read_patch
import worker

sys.path.insert(0, str(Path(__file__).resolve().parent/'frozen'))
from spatial import SpatialGraphExpert, adjacency
from reliable_ensemble import predict, NAMES


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run',type=Path,required=True)
    parser.add_argument('--slide',type=Path,required=True)
    parser.add_argument('--reference',type=Path,required=True)
    parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--samples',type=int,default=128)
    parser.add_argument('--experimental-vectorized',action='store_true')
    args=parser.parse_args()
    print('Verifying original model files and reading the saved slide sample.',flush=True)
    worker.verify_installation(args.run)
    if not torch.cuda.is_available(): raise RuntimeError('CUDA is required for this benchmark.')
    torch.set_num_threads(4)
    torch.backends.cudnn.allow_tf32=True
    torch.backends.cuda.matmul.allow_tf32=False
    reference=args.reference.resolve()
    manifest=json.loads((reference/'manifest.json').read_text())
    with args.slide.open('rb') as stream:
        if manifest['slide_sha256']!=worker.hashlib.file_digest(stream,'sha256').hexdigest():
            raise RuntimeError('Reference belongs to a different input.')
    with sqlite3.connect((reference/'tiles.sqlite').as_uri()+'?mode=ro',uri=True) as db:
        rows=list(db.execute('SELECT x,y,tissue,p0,p1,p2,feature FROM tiles WHERE feature IS NOT NULL ORDER BY y,x'))
    indices=np.unique(np.linspace(0,len(rows)-1,min(args.samples,len(rows)),dtype=int))
    images=[]
    with openslide.OpenSlide(str(args.slide)) as slide:
        level=manifest['read_level']
        region=tuple(max(1,round(s/slide.level_downsamples[level])) for s in manifest['tile_size_level0'])
        for index in indices:
            row=rows[index]
            image,fraction=read_patch(slide,row[0],row[1],level,region)
            if fraction!=row[2]: raise RuntimeError('Tissue fraction mismatch.')
            images.append(image)
    models=[];transforms=[]
    for name in NAMES[:3]:
        model=timm.create_model(name,pretrained=False,num_classes=1).eval()
        model.load_state_dict(torch.load(args.run/f'{name}.pt',map_location='cpu',weights_only=False)['model'])
        config=resolve_model_data_config(model)
        transforms.append(T.Compose([T.ToTensor(),T.Normalize(config['mean'],config['std'])]))
        models.append(model.cuda())
    # Fixed, declared numerical regression gates, not bitwise identity.
    # These are engineering checks, not evidence of clinical equivalence.
    score_atol=1e-3;feature_atol=1e-3;feature_rtol=1e-3;slide_atol=1e-4
    original_scores=np.array([rows[i][3:6] for i in indices])
    original_features=np.stack([np.frombuffer(rows[i][6],dtype='float32') for i in indices])
    all_features=np.stack([np.frombuffer(row[6],dtype='float32') for row in rows])
    all_scores=np.array([row[3:6] for row in rows])
    coords=np.array([[row[0],row[1]] for row in rows],dtype=float)
    checkpoint=torch.load(args.run/'spatial_graph_expert.pt',map_location='cpu',weights_only=False)
    graph=SpatialGraphExpert(checkpoint['feature_dim']).eval()
    graph.load_state_dict(checkpoint['model'])
    edges=adjacency(coords)
    with torch.inference_mode():
        original_graph=float(graph(torch.from_numpy(all_features),edges).sigmoid().item())
    original_prediction=predict(args.run,np.r_[all_scores.max(axis=0),original_graph][None,:])
    results=[]
    print(f'Checking {len(images)} real patches, batches 1/8/16/32, reference convolution policy.',flush=True)
    for batch_size in (1,8,16,32):
        infer_batch(images[:batch_size],models,transforms,'cuda',args.experimental_vectorized)
        torch.cuda.synchronize();started=time.perf_counter()
        scores=[];features=[]
        for offset in range(0,len(images),batch_size):
            part=infer_batch(images[offset:offset+batch_size],models,transforms,'cuda',args.experimental_vectorized)
            scores.extend(part[0]);features.extend(part[1])
        torch.cuda.synchronize();seconds=time.perf_counter()-started
        scores=np.asarray(scores)
        features=np.stack([np.frombuffer(value,dtype='float32') for value in features])
        patch_pass=bool(np.allclose(scores,original_scores,rtol=0,atol=score_atol))
        feature_pass=bool(np.allclose(features,original_features,rtol=feature_rtol,atol=feature_atol))
        replaced_features=all_features.copy();replaced_features[indices]=features
        replaced_scores=all_scores.copy();replaced_scores[indices]=scores
        with torch.inference_mode():
            graph_score=float(graph(torch.from_numpy(replaced_features),edges).sigmoid().item())
        prediction=predict(args.run,np.r_[replaced_scores.max(axis=0),graph_score][None,:])
        slide_pass=bool(np.allclose(graph_score,original_graph,rtol=0,atol=slide_atol) and
                        np.allclose(prediction[0],original_prediction[0],rtol=0,atol=slide_atol) and
                        np.array_equal(prediction[1],original_prediction[1]))
        result=dict(batchSize=batch_size,seconds=round(seconds,4),patchesPerSecond=round(len(images)/seconds,2),
                    maxPatchScoreDifference=float(np.abs(scores-original_scores).max()),
                    perExpertMaxDifference=np.abs(scores-original_scores).max(axis=0).tolist(),
                    maxFeatureDifference=float(np.abs(features-original_features).max()),
                    graphDifference=abs(graph_score-original_graph),
                    ensembleDifference=float(abs(prediction[0][0]-original_prediction[0][0])),
                    patchPassed=patch_pass,featuresPassed=feature_pass,slidePassed=slide_pass,
                    passed=patch_pass and feature_pass and slide_pass)
        results.append(result);print(json.dumps(result),flush=True)
    report=dict(device=torch.cuda.get_device_name(0),samples=len(images),referenceTissuePatches=len(rows),
                vectorized=args.experimental_vectorized,
                thresholds=dict(patchAbsolute=score_atol,featureAbsolute=feature_atol,featureRelative=feature_rtol,slideAbsolute=slide_atol),
                results=results,scope='Real sampled patches and full graph with sampled replacements; excludes download, reads, initialization and artifacts. Not a full-slide validation.')
    args.output.parent.mkdir(parents=True,exist_ok=True)
    args.output.write_text(json.dumps(report,indent=2))
    if not all(result['passed'] for result in results):
        raise SystemExit('Some configurations failed regression; see the recorded per-expert differences.')


if __name__=='__main__': main()
