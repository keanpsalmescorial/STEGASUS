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
def infer_batch(images, models, transforms, device, vectorized=False):
    """Return aligned three-expert scores and the original expert-0 graph features."""
    if not images:
        return [], []
    if len(models) != 3 or len(transforms) != 3:
        raise ValueError('Three appearance experts are required.')
    scores = np.empty((len(images), 3), dtype=np.float64)
    features_out = None
    for j, (model, transform) in enumerate(zip(models, transforms)):
        tensor = torch.stack([transform(image) for image in images])
        if str(device).startswith('cuda'):
            tensor = tensor.pin_memory()
        tensor = tensor.to(device, non_blocking=str(device).startswith('cuda'))
        # Reference-shape mode queues all forwards before a single CPU transfer.
        # Vectorization is explicit/experimental until its numerical gates pass.
        score_parts, feature_parts = [], []
        chunks = [tensor] if vectorized else tensor.split(1)
        for chunk in chunks:
            features = model.forward_features(chunk)
            score_parts.append(model.forward_head(features).sigmoid().reshape(-1))
            if j == 0:
                feature_parts.append(model.forward_head(features, pre_logits=True))
        scores[:, j] = torch.cat(score_parts).cpu().numpy()
        if j == 0:
            encoded = torch.cat(feature_parts).cpu().numpy().astype('float32')
            features_out = [row.reshape(-1).tobytes() for row in encoded]
        del features, tensor
    return scores.tolist(), features_out


def infer_with_memory_fallback(images, models, transforms, device, vectorized=False):
    """Split a batch on CUDA OOM without dropping patches or changing precision."""
    try:
        return infer_batch(images, models, transforms, device, vectorized=vectorized)
    except torch.cuda.OutOfMemoryError:
        if len(images) <= 1:
            raise
    # Outside the except block so failed-forward tracebacks release GPU tensors.
    torch.cuda.empty_cache()
    middle = len(images) // 2
    left = infer_with_memory_fallback(images[:middle], models, transforms, device, vectorized)
    right = infer_with_memory_fallback(images[middle:], models, transforms, device, vectorized)
    return left[0] + right[0], left[1] + right[1]


def commit_batch(db, pending, models, transforms, device, vectorized=False):
    accepted = [item for item in pending if item[3] is not None]
    scores, features = infer_with_memory_fallback([item[3] for item in accepted], models, transforms, device, vectorized)
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
