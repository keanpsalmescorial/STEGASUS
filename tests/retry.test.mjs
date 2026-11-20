import test from 'node:test';
import assert from 'node:assert/strict';
import {retryState,submissionLimitMessage} from '../supabase/functions/inference/retry.mjs';
const job={status:'failed',object_present:true,size_bytes:123};
test('a retry verifies the existing object and clears stale attempts, leases, results and errors',()=>{
  const patch=retryState(job,123,'now');assert.equal(patch.status,'queued');assert.equal(patch.attempts,0);
  for(const k of ['error','result','worker_id','lease_token','lease_until','upload_id'])assert.equal(patch[k],null);
  assert.deepEqual(patch.artifacts,[]);assert.equal(patch.object_key,undefined);assert.equal(patch.size_bytes,undefined);
});
test('active, cancelled, completed, missing and truncated uploads cannot be retried',()=>{
  for(const status of ['queued','processing','completed','cancelled','uploading'])assert.throws(()=>retryState({...job,status},123,'now'));
  for(const storedSize of [null,0,122,124,NaN])assert.throws(()=>retryState(job,storedSize,'now'));
  assert.throws(()=>retryState({...job,object_present:false},123,'now'));
});
test('storage budget errors offer reuse and do not expose database errors',()=>{
  assert.match(submissionLimitMessage('Upload budget reached'),/Retry.*already uploaded|already uploaded.*Retry/i);
  assert.match(submissionLimitMessage('Hourly submission limit reached'),/Hourly/);
  assert.doesNotMatch(submissionLimitMessage('private internal error'),/private/);
});
