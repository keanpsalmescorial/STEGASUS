import test from 'node:test';
import assert from 'node:assert/strict';
import {checkedId,checkUpload,partLength,verifyParts,checkResult,artifactKey,PART_SIZE,FROZEN_THRESHOLD} from '../supabase/functions/inference/validation.mjs';
const id='f5f538af-d173-47d6-b5b5-5d11825f31e8';
const slide={filename:'deidentified-sample.TIFF',authorized:true,caseId:'case 31',size:PART_SIZE+5};
test('accepts authorized TIFF and valid identifier',()=>{assert.equal(checkedId(id),id);checkUpload(slide,2*PART_SIZE);});
test('rejects unsupported format, unsafe name, unauthorized upload, missing identifier and excessive or empty slides',()=>{
  for(const change of [{filename:'slide.ndpi'},{filename:'../slide.tif'},{filename:'a\\b.tif'},{authorized:false},{caseId:' '},{size:0},{size:2*PART_SIZE+1}])assert.throws(()=>checkUpload({...slide,...change},2*PART_SIZE));
  assert.throws(()=>checkedId('invalid'));
});
test('expected multipart boundaries reject duplicates, truncation, missing tags, gaps',()=>{
  assert.equal(partLength(slide.size,1),PART_SIZE);assert.equal(partLength(slide.size,2),5);
  assert.throws(()=>partLength(slide.size,3));
  const a={PartNumber:1,Size:PART_SIZE,ETag:'a'},b={PartNumber:2,Size:5,ETag:'b'};
  verifyParts([a,b],slide.size);
  for(const parts of [[a],[a,a],[a,{...b,Size:4}],[a,{...b,ETag:null}],[b,a]])assert.throws(()=>verifyParts(parts,slide.size));
});
test('accepts only bounded four-expert results at frozen threshold',()=>{
  const r={score:0.65,threshold:0.628536,patchCount:31,modelVersion:'frozen',expertScores:{a:.5,b:.6,c:.3,d:.2}};
  checkResult(r);checkResult({...r,threshold:FROZEN_THRESHOLD});
  for(const bad of [{score:NaN},{score:1.01},{threshold:.5},{patchCount:0},{expertScores:{a:.3}},{expertScores:{a:-1,b:0,c:1,d:0}}])assert.throws(()=>checkResult({...r,...bad}));
});
test('artifact paths are bound to one workspace, job and lease; unsupported types fail closed',()=>{
  const j={workspace_id:id,id:'job',lease_token:'lease'};assert.equal(artifactKey(j,'heatmap','image/png'),id+'/job/lease/heatmap.png');
  for(const k of ['__proto__','toString','../other'])assert.throws(()=>artifactKey(j,k,'image/png'));
  assert.throws(()=>artifactKey(j,'heatmap','text/html'));
});