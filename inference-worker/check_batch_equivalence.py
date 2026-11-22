"""Compare real frozen experts on nine synthetic patches; never accesses the queue."""
import argparse
import json
from pathlib import Path
import sys
import time
import numpy as np
import torch
import timm
from PIL import Image
from torchvision import transforms as T
from timm.data import resolve_model_data_config
from patch_batches import infer_batch
import worker

sys.path.insert(0,str(Path(__file__).resolve().parent/'frozen'))
from spatial import SpatialGraphExpert, adjacency
from reliable_ensemble import predict, NAMES


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run',type=Path,required=True)
    args=parser.parse_args()
    worker.verify_installation(args.run)
    torch.set_num_threads(4)
    torch.backends.cudnn.allow_tf32=True
    torch.backends.cuda.matmul.allow_tf32=False
    device='cuda' if torch.cuda.is_available() else 'cpu'
    rng=np.random.default_rng(42)
    images=[Image.fromarray(rng.integers(0,256,(96,96,3),dtype=np.uint8)) for _ in range(9)]
    models=[];transforms=[]
    for name in NAMES[:3]:
        model=timm.create_model(name,pretrained=False,num_classes=1).eval()
        model.load_state_dict(torch.load(args.run/f'{name}.pt',map_location='cpu',weights_only=False)['model'])
        cfg=resolve_model_data_config(model)
        transforms.append(T.Compose([T.ToTensor(),T.Normalize(cfg['mean'],cfg['std'])]))
        models.append(model.to(device))
    print(f'Comparing nine synthetic patches on {device}; no slide jobs are run.',flush=True)
    with torch.inference_mode():
        single_scores=[];single_features=[]
        for image in images:
            row=[]
            for j,(model,transform) in enumerate(zip(models,transforms)):
                tensor=transform(image).unsqueeze(0).to(device)
                feature=model.forward_features(tensor)
                row.append(float(model.forward_head(feature).sigmoid().item()))
                if j==0:
                    single_features.append(model.forward_head(feature,pre_logits=True).cpu().numpy().astype('float32').reshape(-1))
            single_scores.append(row)
        batch_scores,raw=infer_batch(images,models,transforms,device)
        batch_features=np.stack([np.frombuffer(value,dtype='float32') for value in raw])
        np.testing.assert_allclose(batch_scores,single_scores,rtol=0,atol=1e-3)
        np.testing.assert_allclose(batch_features,single_features,rtol=1e-3,atol=1e-3)
        coords=np.array([[x,y] for y in range(3) for x in range(3)],dtype=float)
        checkpoint=torch.load(args.run/'spatial_graph_expert.pt',map_location='cpu',weights_only=False)
        graph=SpatialGraphExpert(checkpoint['feature_dim']).eval()
        graph.load_state_dict(checkpoint['model'])
        graph_scores=[float(graph(torch.from_numpy(np.stack(features)),adjacency(coords)).sigmoid().item()) for features in [single_features,batch_features]]
        bases=[np.r_[np.max(scores,axis=0),g][None,:] for scores,g in zip([single_scores,batch_scores],graph_scores)]
        predictions=[predict(args.run,base) for base in bases]
        np.testing.assert_allclose(graph_scores[0],graph_scores[1],rtol=0,atol=1e-4)
        np.testing.assert_allclose(predictions[0][0],predictions[1][0],rtol=0,atol=1e-4)
        np.testing.assert_array_equal(predictions[0][1],predictions[1][1])
    print(json.dumps({'passed':True,'device':device,'syntheticPatches':9,'maxAppearanceScoreDifference':float(np.max(np.abs(np.array(batch_scores)-single_scores))),'maxFeatureDifference':float(np.max(np.abs(batch_features-single_features))),'graphScores':graph_scores,'ensembleScores':[float(p[0][0]) for p in predictions],'scope':'synthetic patch regression only; full-slide equivalence and speed not measured'},indent=2))


if __name__=='__main__':
    main()
