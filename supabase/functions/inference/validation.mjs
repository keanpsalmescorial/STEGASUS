export const PART_SIZE = 32 * 1024 * 1024;
export const FROZEN_THRESHOLD = 0.6285356451984643;
export const ARTIFACT_TYPES = {
  heatmap: ['image/png','image/jpeg'],
  thumbnail: ['image/png','image/jpeg'],
  records: ['application/json','text/csv'],
  patch_scores: ['text/csv','application/json']
};
export class Problem extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export function insist(test, status, message) { if (!test) throw new Problem(status,message); }
export function checkedId(value) {
  insist(typeof value==='string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value),400,'Invalid identifier.');
  return value;
}
export function checkUpload(data,limit) {
  insist(data.authorized===true,400,'Confirm authorization and de-identification.');
  insist(typeof data.filename==='string' && /^[^/\\\x00-\x1f\x7f]{1,195}\.tiff?$/i.test(data.filename),400,'Choose a TIFF research slide.');
  insist(typeof data.caseId==='string' && data.caseId.trim().length>0 && data.caseId.trim().length<=100,400,'Enter a research case identifier.');
  insist(Number.isSafeInteger(data.size) && data.size>0 && data.size<=limit,413,'Slide exceeds the configured file limit or is empty.');
}
export function partLength(size,part) {
  insist(Number.isSafeInteger(part)&&part>=1&&part<=Math.ceil(size/PART_SIZE),400,'Invalid upload part.');
  return Math.min(PART_SIZE,size-(part-1)*PART_SIZE);
}
export function verifyParts(parts,size) {
  insist(parts.length===Math.ceil(size/PART_SIZE),409,'Upload is incomplete.');
  parts.forEach((part,i)=>insist(part.PartNumber===i+1 && part.Size===partLength(size,i+1) && typeof part.ETag==='string',409,'One or more parts require a fresh upload.'));
}
export function checkResult(result) {
  insist(result && typeof result==='object' && typeof result.score==='number' && result.score>=0 && result.score<=1,400,'Invalid ensemble score.');
  insist(Number.isFinite(result.threshold) && Math.abs(result.threshold-FROZEN_THRESHOLD)<=0.0000005,400,'Threshold differs from the frozen model.');
  insist(typeof result.modelVersion==='string' && result.modelVersion.length>0 && result.modelVersion.length<=180 && Number.isSafeInteger(result.patchCount) && result.patchCount>0,400,'Missing model provenance.');
  const pairs=Object.entries(result.expertScores??{});
  insist(pairs.length===4 && pairs.every(([name,v])=>name.length<=64 && typeof v==='number'&&v>=0&&v<=1),400,'Four genuine expert scores are required.');
}
export function artifactKey(job,kind,mime) {
  insist(Object.hasOwn(ARTIFACT_TYPES,kind) && ARTIFACT_TYPES[kind].includes(mime),400,'Unsupported artifact.');
  return job.workspace_id+'/'+job.id+'/'+job.lease_token+'/'+kind+'.'+({'image/png':'png','image/jpeg':'jpg','text/csv':'csv','application/json':'json'}[mime]);
}