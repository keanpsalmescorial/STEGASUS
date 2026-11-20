import test from 'node:test';
import assert from 'node:assert/strict';
import {reportHtml,reportRows} from '../dist/studio/analysis-report.mjs';
const job={status:'completed',case_id:'Research <case>',filename:'slide.tif',result:{classification:'Below threshold',score:.33,threshold:.628536,patchCount:123,modelVersion:'frozen',expertScores:{resnet50:.8}}};
test('report requires a completed analysis and retains model provenance',()=>{
  assert.throws(()=>reportRows({...job,status:'processing'}));
  const html=reportHtml(job);assert.match(html,/0.628536/);assert.match(html,/resnet50/);assert.match(html,/does not rule out metastasis/);assert.match(html,/Research &lt;case&gt;/);
});
test('report escapes user fields and only embeds local image data',()=>{
  const html=reportHtml({...job,case_id:'<script>alert(1)</script>'},[{kind:'heatmap',data:'https://untrusted.invalid/x.png'},{kind:'thumbnail',data:'data:image/png;base64,YQ=='}]);
  assert.doesNotMatch(html,/<script>|untrusted.invalid/);assert.match(html,/data:image\/png;base64,YQ==/);
});
