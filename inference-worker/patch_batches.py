"""Direct OpenSlide reads with the frozen pixel and tissue-selection contract."""
import numpy as np
import torch
from PIL import Image


def read_patch(slide, x, y, level, region):
    rgba = slide.read_region((x, y), level, region)
    background = Image.new('RGBA', rgba.size, 'white')
    rgb = Image.alpha_composite(background, rgba).convert('RGB').resize((96, 96), Image.Resampling.BILINEAR)
    hsv = np.asarray(rgb.convert('HSV'))
    fraction = float(((hsv[:, :, 1] > 20) & (hsv[:, :, 2] < 245)).mean())
    return rgb, fraction


@torch.inference_mode()
def infer_batch(images, models, transforms, device):
    """Return aligned three-expert scores and the original expert-0 graph features."""
    if not images:
        return [], []
    if len(models) != 3 or len(transforms) != 3:
        raise ValueError('Three appearance experts are required.')
    scores = np.empty((len(images), 3), dtype=np.float64)
    features_out = None
    for j, (model, transform) in enumerate(zip(models, transforms)):
        tensor = torch.stack([transform(image) for image in images]).to(device)
        if j == 0:
            features_out = []
        # Preserve the frozen batch-one forward shape: vectorized CUDA kernels
        # exhibited score drift in regression. Batching still reduces transfers,
        # preprocessing overhead and SQLite commits; weights stay on the device.
        for i in range(len(images)):
            features = model.forward_features(tensor[i:i+1])
            scores[i,j] = float(model.forward_head(features).sigmoid().item())
            if j == 0:
                features_out.append(model.forward_head(features,pre_logits=True).cpu().numpy().astype('float32').reshape(-1).tobytes())
            del features
        del tensor
    return scores.tolist(), features_out


def commit_batch(db, pending, models, transforms, device):
    accepted = [item for item in pending if item[3] is not None]
    scores, features = infer_batch([item[3] for item in accepted], models, transforms, device)
    index = 0
    rows = []
    for x, y, fraction, image in pending:
        if image is None:
            rows.append((x, y, fraction, None, None, None, None))
        else:
            rows.append((x, y, fraction, *scores[index], features[index]))
            index += 1
    # One atomic transaction: interruption cannot leave half a batch marked complete.
    with db:
        db.executemany('INSERT INTO tiles VALUES (?,?,?,?,?,?,?)', rows)
    return len(rows)
