export const stageLabels={download:'Downloading slide',preparing:'Loading models and checking slide',patches:'Analyzing tissue patches',graph:'Combining spatial evidence and preparing visualizations',artifacts:'Saving results',complete:'Results ready'};
export function progressView(job,now=Date.now()){
  if(job.status==='completed')return {label:'Results ready',percent:100,eta:'Completed'};
  if(job.status!=='processing')return {label:job.status==='queued'?'Waiting for an available worker':job.status,percent:null,eta:job.status==='queued'?'Time estimate available after processing starts':''};
  const p=job.progress??job.result?.progress;
  if(!p)return {label:'Processing',percent:null,eta:'Waiting for progress from the worker'};
  const age=(now-Date.parse(p.reportedAt))/1000;
  const fraction=p.total>0?Math.min(1,p.completed/p.total):null;
  const stage=stageLabels[p.stage]||'Processing';
  const elapsed=Math.floor((p.elapsedSeconds||0)/60);
  if(!Number.isFinite(age)||age>45)return {label:stage,percent:fraction===null?null:fraction*100,eta:'Progress update delayed; time estimate paused',elapsed};
  let eta='Calculating time remaining';
  if(Number.isFinite(p.etaSeconds)&&p.etaSeconds>0){
    const minutes=Math.max(1,Math.ceil(p.etaSeconds/60));
    eta=`About ${minutes} min remaining ${p.etaScope==='total'?'until results':'in this stage; final result time is still being estimated'}`;
  }
  return {label:stage+(fraction===null?'':` � ${p.completed.toLocaleString()} / ${p.total.toLocaleString()} ${p.stage==='download'?'bytes':p.stage==='patches'?'patches':'files'}`),percent:fraction===null?null:fraction*100,eta,elapsed};
}
