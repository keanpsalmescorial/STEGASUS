import {insist} from './validation.mjs';
export function checkedProgress(p,reportedAt){
  insist(p&&['download','preparing','patches','graph','artifacts','complete'].includes(p.stage),400,'Invalid processing stage.');
  for(const key of ['completed','total'])insist(Number.isSafeInteger(p[key])&&p[key]>=0&&p[key]<=1e12,400,'Invalid progress count.');
  insist(p.total===0?p.completed===0:p.completed<=p.total,400,'Progress exceeds total.');
  insist(Number.isFinite(p.elapsedSeconds)&&p.elapsedSeconds>=0&&p.elapsedSeconds<=604800,400,'Invalid elapsed time.');
  insist(p.etaSeconds===null||(Number.isFinite(p.etaSeconds)&&p.etaSeconds>=0&&p.etaSeconds<=604800),400,'Invalid time estimate.');
  insist(p.etaScope===null||['stage','total'].includes(p.etaScope),400,'Invalid estimate scope.');
  insist(['frozen','direct'].includes(p.pipeline),400,'Invalid processing pipeline.');
  return {stage:p.stage,completed:p.completed,total:p.total,elapsedSeconds:p.elapsedSeconds,etaSeconds:p.etaSeconds,etaScope:p.etaScope,pipeline:p.pipeline,reportedAt};
}
