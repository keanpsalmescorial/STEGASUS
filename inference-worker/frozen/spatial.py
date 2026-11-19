"""Spatial bags use genuine PCam coordinates, never patch order as position."""
import csv
import hashlib
import json
import random
from pathlib import Path
import h5py
import numpy as np
import torch
from torch import nn
from sklearn.neighbors import NearestNeighbors

GRAPH_NAME = 'spatial_graph_expert'
# The upstream README transposes valid/test MD5 values. These hashes are of
# the downloaded file IDs below; row labels are independently checked against HDF5.
META = {'train': ('1XoaGG3ek26YLFvGzmkKeOz54INW0fruR', '5a3dd671e465cfd74b5b822125e65b0a'),
        'val': ('16hJfGFCZEcvR3lr38v3XCaD5iH1Bnclg', '67589e00a4a37ec317f2d1932c7502ca'),
        'test': ('19tj7fBlQQrd4DapCjhZrom_fA4QlHqN4', '3455fd69135b66734e1008f3af684566')}

def meta_path(root, split):
    return root / 'data' / 'pcam' / f"camelyonpatch_level_2_split_{'valid' if split == 'val' else split}_meta.csv"

def download_metadata(root):
    import gdown
    for split, (file_id, digest) in META.items():
        path = meta_path(root, split)
        if not path.exists():
            tmp = path.with_suffix('.download')
            gdown.download(id=file_id, output=str(tmp), quiet=False)
            if hashlib.md5(tmp.read_bytes()).hexdigest() != digest:
                raise RuntimeError('Metadata checksum mismatch')
            tmp.replace(path)
        if hashlib.md5(path.read_bytes()).hexdigest() != digest:
            raise RuntimeError(f'Unexpected official metadata: {path}')

class SlideIndex:
    def __init__(self, root, split):
        path = meta_path(root, split)
        if not path.exists():
            raise RuntimeError('Missing spatial metadata. Run the download task first.')
        if hashlib.md5(path.read_bytes()).hexdigest() != META[split][1]:
            raise ValueError('Metadata does not match the official PCam row order')
        with path.open(newline='') as f:
            rows = list(csv.DictReader(f))
        prefix = 'valid' if split == 'val' else split
        with h5py.File(root / 'data' / 'pcam' / f'camelyonpatch_level_2_split_{prefix}_y.h5') as f:
            patch_y = f['y'][:].reshape(-1)
        if len(rows) != len(patch_y):
            raise ValueError('Metadata/patch count mismatch')
        groups = {}
        for i, row in enumerate(rows):
            if int(row['']) != i or int(row['center_tumor_patch'] == 'True') != patch_y[i]:
                raise ValueError('Metadata/patch label alignment mismatch')
            groups.setdefault(row['wsi'], []).append(i)
        self.exclusions = {}
        exclusion_path = root / 'data' / 'test_slide_exclusions.json'
        if split == 'test' and exclusion_path.exists():
            self.exclusions = json.loads(exclusion_path.read_text())
            if set(self.exclusions) - groups.keys():
                raise ValueError('Excluded slide is not present in metadata')
        self.ids = sorted(set(groups) - self.exclusions.keys())
        self.indices = [np.asarray(groups[s], dtype=np.int64) for s in self.ids]
        self.coords = np.asarray([[float(r['coord_x']), float(r['coord_y'])] for r in rows])
        if not np.isfinite(self.coords).all():
            raise ValueError('Non-finite coordinates')
        labels = {}
        label_path = root / 'data' / 'slide_labels.csv'
        if label_path.exists():
            with label_path.open(newline='') as f:
                for r in csv.DictReader(f):
                    if r['slide_id'] in labels:
                        raise ValueError('Duplicate slide label')
                    labels[r['slide_id']] = int(r['label'])
        self.labels = []
        for sid in self.ids:
            if sid.startswith('camelyon16_train_tumor_'):
                label = 1
            elif sid.startswith('camelyon16_train_normal_'):
                label = 0
            elif sid in labels:
                label = labels[sid]
            else:
                raise RuntimeError(f'Missing verified slide label for {sid}. Supply data/slide_labels.csv (slide_id,label).')
            if label not in (0, 1):
                raise ValueError('Slide labels must be binary')
            self.labels.append(label)
        self.labels = np.asarray(self.labels)
        self.fingerprint = hashlib.sha256(path.read_bytes() + self.labels.tobytes()).hexdigest()

    def aggregate(self, probabilities):
        p = np.asarray(probabilities)
        if p.shape != (len(self.coords),) or not np.isfinite(p).all():
            raise ValueError('Patch predictions do not align with metadata')
        return np.asarray([p[idx].max() for idx in self.indices])

def assert_disjoint(*indices):
    seen = set()
    for index in indices:
        if seen.intersection(index.ids):
            raise ValueError('Source slides overlap between splits')
        seen.update(index.ids)

def adjacency(coords, k=8):
    coords = np.asarray(coords)
    n = len(coords)
    if n == 0 or not np.isfinite(coords).all():
        raise ValueError('A graph requires finite coordinates and at least one node')
    edges = {(i, i) for i in range(n)}
    if n > 1:
        neighbors = NearestNeighbors(n_neighbors=min(k+1, n), algorithm='kd_tree').fit(coords).kneighbors(coords, return_distance=False)
        for i, candidates in enumerate(neighbors):
            for j in [int(j) for j in candidates if j != i][:min(k, n-1)]:
                edges.add((i, j))
                edges.add((j, i))
    ij = torch.tensor(sorted(edges), dtype=torch.long).T
    degree = torch.bincount(ij[0], minlength=n).float()
    values = (degree[ij[0]] * degree[ij[1]]).rsqrt()
    return torch.sparse_coo_tensor(ij, values, (n, n)).coalesce()

class SpatialGraphExpert(nn.Module):
    def __init__(self, feature_dim, hidden_dim=256):
        super().__init__()
        self.projection = nn.Sequential(nn.Linear(feature_dim, hidden_dim), nn.ReLU(), nn.Dropout(.2))
        self.attention = nn.Sequential(nn.Linear(hidden_dim, 128), nn.Tanh(), nn.Linear(128, 1))
        self.classifier = nn.Linear(hidden_dim, 1)

    def forward(self, features, adj):
        h = self.projection(features)
        h_final = h + torch.sparse.mm(adj, h)
        weights = self.attention(h_final).softmax(dim=0)
        return self.classifier((weights * h_final).sum(dim=0)).reshape(())

@torch.inference_mode()
def features(root, run, split, index, batch, device):
    import timm
    from train import loader
    encoder_path = run / 'efficientnet_b0.pt'
    signature = hashlib.sha256(encoder_path.read_bytes()).hexdigest() + index.fingerprint
    path = run / f'{split}_features.npy'
    stamp = path.with_suffix('.json')
    if path.exists() and stamp.exists() and json.loads(stamp.read_text())['signature'] == signature:
        return np.load(path, mmap_mode='r')
    encoder = timm.create_model('efficientnet_b0', pretrained=False, num_classes=1).to(device)
    encoder.load_state_dict(torch.load(encoder_path, map_location='cpu', weights_only=False)['model'])
    encoder.eval()
    batches, _ = loader(split, encoder, batch)
    tmp = path.with_suffix('.tmp.npy')
    output = np.lib.format.open_memmap(tmp, mode='w+', dtype='float32', shape=(len(index.coords), encoder.num_features))
    offset = 0
    from tqdm import tqdm
    for x, _ in tqdm(batches, desc=f'{split} frozen graph features'):
        f = encoder.forward_head(encoder.forward_features(x.to(device)), pre_logits=True).cpu().numpy()
        output[offset:offset+len(f)] = f
        offset += len(f)
    assert offset == len(index.coords)
    output.flush()
    del output, encoder
    tmp.replace(path)
    stamp.write_text(json.dumps({'signature': signature}))
    return np.load(path, mmap_mode='r')

def graph_predict(model, feature_array, index, device):
    model.eval()
    values = []
    with torch.inference_mode():
        for idx in index.indices:
            x = torch.from_numpy(np.array(feature_array[idx])).to(device)
            values.append(model(x, adjacency(index.coords[idx]).to(device)).sigmoid().item())
    return np.asarray(values)

def fit_graph(root, run, train_index, val_index, epochs, batch):
    device = 'cuda'
    train_f = features(root, run, 'train', train_index, batch, device)
    val_f = features(root, run, 'val', val_index, batch, device)
    # Fixed seed independent of time spent extracting features or rerunning earlier branches.
    torch.manual_seed(42)
    model = SpatialGraphExpert(train_f.shape[1]).to(device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=1e-4, weight_decay=1e-4)
    path = run / f'{GRAPH_NAME}.pt'
    start, history = 0, []
    if path.exists():
        c = torch.load(path, map_location='cpu', weights_only=False)
        if c['train_fingerprint'] != train_index.fingerprint:
            raise RuntimeError('Graph training metadata changed')
        model.load_state_dict(c['model'])
        optimizer.load_state_dict(c['optimizer'])
        torch.set_rng_state(c['torch_rng'])
        torch.cuda.set_rng_state_all(c['cuda_rng'])
        start, history = c['epoch'], c['history']
    from tqdm import tqdm
    for epoch in range(start, epochs):
        model.train()
        losses = []
        for bag in tqdm(np.random.default_rng(42+epoch).permutation(len(train_index.ids)), desc=f'Graph epoch {epoch+1}/{epochs}'):
            idx = train_index.indices[bag]
            x = torch.from_numpy(np.array(train_f[idx])).to(device)
            adj = adjacency(train_index.coords[idx]).to(device)
            optimizer.zero_grad(set_to_none=True)
            logit = model(x, adj)
            loss = nn.functional.binary_cross_entropy_with_logits(logit, torch.tensor(float(train_index.labels[bag]), device=device))
            loss.backward()
            optimizer.step()
            losses.append(loss.item())
        history.append({'epoch': epoch+1, 'loss': float(np.mean(losses))})
        tmp = path.with_suffix('.tmp')
        torch.save(dict(model=model.state_dict(), optimizer=optimizer.state_dict(), epoch=epoch+1,
                        feature_dim=train_f.shape[1], train_fingerprint=train_index.fingerprint,
                        history=history, torch_rng=torch.get_rng_state(), cuda_rng=torch.cuda.get_rng_state_all()), tmp)
        tmp.replace(path)
        (run / 'graph_history.json').write_text(json.dumps(history, indent=2))
        print(f'Saved graph epoch {epoch+1}', flush=True)
    return graph_predict(model, val_f, val_index, device)

def evaluate_graph(root, run, index, batch, device):
    f = features(root, run, 'test', index, batch, device)
    c = torch.load(run / f'{GRAPH_NAME}.pt', map_location='cpu', weights_only=False)
    model = SpatialGraphExpert(c['feature_dim']).to(device)
    model.load_state_dict(c['model'])
    return graph_predict(model, f, index, device)

