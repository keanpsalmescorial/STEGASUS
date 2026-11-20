import test from 'node:test';
import assert from 'node:assert/strict';
import {checkedProgress} from '../supabase/functions/inference/progress.mjs';
import {progressView} from '../dist/studio/progress.mjs';
const now='2026-11-20T07:00:00Z';
const progress={stage:'patches',completed:100,total:1000,elapsedSeconds:70,etaSeconds:180,etaScope:'stage',pipeline:'direct'};
test('telemetry validation rejects invalid counts, unsafe fields and invalid estimates',()=>{
  const clean=checkedProgress({...progress,secret:'must not persist'},now);assert.equal(clean.secret,undefined);
  for(const change of [{stage:'oops'},{completed:-1},{total:1},{etaSeconds:NaN},{elapsedSeconds:-1},{pipeline:'unknown'}])assert.throws(()=>checkedProgress({...progress,...change},now));
});
test('stage progress and ETA never imply a whole-slide promise',()=>{
  const view=progressView({status:'processing',progress:checkedProgress(progress,now)},Date.parse(now));
  assert.equal(view.percent,10);assert.match(view.eta,/3 min.*in this stage/);
});
test('old telemetry pauses ETA and missing telemetry stays indeterminate',()=>{
  const view=progressView({status:'processing',progress:checkedProgress(progress,now)},Date.parse(now)+60000);
  assert.match(view.eta,/paused/);assert.equal(progressView({status:'processing'}).percent,null);
});
test('only completed jobs show complete; queue has no invented countdown',()=>{
  assert.equal(progressView({status:'completed'}).percent,100);
  assert.match(progressView({status:'queued'}).eta,/after processing starts/);
});
test('progress is read from the protected existing job result metadata',()=>{
  const view=progressView({status:'processing',result:{progress:checkedProgress({...progress,etaScope:'total'},now)}},Date.parse(now));
  assert.match(view.eta,/until results/);assert.equal(view.percent,10);
});
