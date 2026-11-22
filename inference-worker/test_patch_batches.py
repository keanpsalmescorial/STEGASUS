"""Local regression checks; no queue, network, training or whole-slide inference."""
import sqlite3
import unittest
from unittest.mock import patch
import numpy as np
import torch
from PIL import Image
from torchvision import transforms as T
from patch_batches import read_patch, infer_batch, commit_batch, infer_with_memory_fallback


class Slide:
    def read_region(self, coord, level, region):
        rng=np.random.default_rng(coord[0]+coord[1]+level)
        return Image.fromarray(rng.integers(0,256,(*region[::-1],4),dtype=np.uint8),'RGBA')


class Expert(torch.nn.Module):
    def forward_features(self,x):
        return x.mean(dim=(2,3))
    def forward_head(self,x,pre_logits=False):
        return x if pre_logits else x.sum(dim=1,keepdim=True)


class Tests(unittest.TestCase):
    def test_each_expert_receives_full_batch_in_one_forward(self):
        class Counter(Expert):
            def forward_features(self, x):
                self.sizes = getattr(self, 'sizes', []) + [x.shape[0]]
                return super().forward_features(x)
        models = [Counter() for _ in range(3)]
        images = [Image.new('RGB', (96,96), 'purple')]*8
        infer_batch(images, models, [T.ToTensor()]*3, 'cpu', vectorized=True)
        self.assertEqual([model.sizes for model in models], [[8],[8],[8]])

    def test_oom_splits_without_losing_or_reordering_patches(self):
        def fake(images, *args, **kwargs):
            if len(images)>2: raise torch.cuda.OutOfMemoryError()
            return images, images
        with patch('patch_batches.infer_batch', fake), patch('torch.cuda.empty_cache'):
            scores, features = infer_with_memory_fallback(list(range(7)), [], [], 'cuda')
        self.assertEqual(scores, list(range(7)))
        self.assertEqual(features, list(range(7)))

    def test_pixels_and_tissue_equal_frozen_operations(self):
        for region in [(96,96),(131,80),(1,1)]:
            slide=Slide()
            rgba=slide.read_region((7,19),1,region)
            rgb=Image.alpha_composite(Image.new('RGBA',rgba.size,'white'),rgba).convert('RGB').resize((96,96),Image.Resampling.BILINEAR)
            hsv=np.asarray(rgb.convert('HSV'))
            expected=float(((hsv[:,:,1]>20)&(hsv[:,:,2]<245)).mean())
            actual,fraction=read_patch(slide,7,19,1,region)
            np.testing.assert_array_equal(np.asarray(actual),np.asarray(rgb))
            self.assertEqual(fraction,expected)

    def test_batch_preserves_single_patch_scores_and_features(self):
        images=[read_patch(Slide(),x,0,0,(96,96))[0] for x in range(3)]
        models=[Expert().eval() for _ in range(3)]
        transforms=[T.ToTensor()]*3
        batch,features=infer_batch(images,models,transforms,'cpu')
        for i,image in enumerate(images):
            single,encoded=infer_batch([image],models,transforms,'cpu')
            np.testing.assert_allclose(batch[i],single[0],rtol=1e-6,atol=1e-7)
            np.testing.assert_allclose(np.frombuffer(features[i],dtype='float32'),np.frombuffer(encoded[0],dtype='float32'))

    def test_background_rows_and_features_remain_coordinate_aligned(self):
        db=sqlite3.connect(':memory:')
        db.execute('CREATE TABLE tiles(x INTEGER,y INTEGER,tissue REAL,p0 REAL,p1 REAL,p2 REAL,feature BLOB,PRIMARY KEY(x,y))')
        image=read_patch(Slide(),0,0,0,(96,96))[0]
        pending=[(0,0,0.0,None),(96,0,0.9,image),(192,0,0.0,None)]
        self.assertEqual(commit_batch(db,pending,[Expert()]*3,[T.ToTensor()]*3,'cpu'),3)
        rows=db.execute('select x,feature from tiles order by y,x').fetchall()
        self.assertEqual([r[0] for r in rows],[0,96,192])
        self.assertIsNone(rows[0][1]);self.assertIsNotNone(rows[1][1]);self.assertIsNone(rows[2][1])
        with self.assertRaises(sqlite3.IntegrityError):
            commit_batch(db,[(288,0,0,None),(0,0,0,None)],[Expert()]*3,[T.ToTensor()]*3,'cpu')
        self.assertEqual(db.execute('select count(*) from tiles').fetchone()[0],3)
        db.close()


if __name__=='__main__':
    torch.set_num_threads(4)
    unittest.main()
