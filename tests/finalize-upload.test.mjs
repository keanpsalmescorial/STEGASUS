import test from 'node:test';
import assert from 'node:assert/strict';
import { finalizeUpload } from '../supabase/functions/inference/finalize.mjs';
import { PART_SIZE } from '../supabase/functions/inference/validation.mjs';

const job={size_bytes:PART_SIZE+5};
const parts=[{PartNumber:1,Size:PART_SIZE,ETag:'a'},{PartNumber:2,Size:5,ETag:'b'}];

test('an already completed object is verified without repeating multipart completion',async()=>{
  await finalizeUpload(job,{head:async()=>job.size_bytes,parts:()=>assert.fail('must not list'),complete:()=>assert.fail('must not complete')});
});
test('all parts must be present and have the declared sizes before completion',async()=>{
  for(const invalid of [parts.slice(0,1),[parts[0],{...parts[1],Size:4}]]){
    await assert.rejects(finalizeUpload(job,{head:async()=>null,parts:async()=>invalid,complete:()=>assert.fail('must not complete')}));
  }
});
test('a lost completion response is recovered only when the full object exists',async()=>{
  let reads=0;
  await finalizeUpload(job,{head:async()=>++reads===1?null:job.size_bytes,parts:async()=>parts,complete:async()=>{throw new Error('unexpected end of file');}});
  assert.equal(reads,2);
});
test('a completion failure without a verified object remains an error',async()=>{
  await assert.rejects(finalizeUpload(job,{head:async()=>null,parts:async()=>parts,complete:async()=>{throw new Error('unexpected end of file');}}),/unexpected end of file/);
});
test('successful multipart completion still requires the correct final object size',async()=>{
  for(const actual of [null,job.size_bytes-1,job.size_bytes]){
    let reads=0,completed=false;
    const promise=finalizeUpload(job,{head:async()=>++reads===1?null:actual,parts:async()=>parts,complete:async()=>{completed=true;}});
    if(actual===job.size_bytes)await promise;else await assert.rejects(promise,/Uploaded size differs/);
    assert.equal(completed,true);
  }
});
