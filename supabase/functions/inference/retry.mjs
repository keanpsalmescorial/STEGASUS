import {insist} from './validation.mjs';

export function retryState(job,storedSize,updatedAt){
  insist(job.status==='failed',409,'Only failed analyses can be retried. Refresh the job status.');
  insist(job.object_present===true,409,'This analysis has no verified stored slide. Choose a slide to upload.');
  insist(Number.isSafeInteger(storedSize)&&storedSize===job.size_bytes,409,'The stored slide is missing or incomplete. A fresh upload is required.');
  return {status:'queued',attempts:0,error:null,result:null,artifacts:[],worker_id:null,lease_token:null,lease_until:null,upload_id:null,updated_at:updatedAt};
}

export function submissionLimitMessage(message){
  return message==='Upload budget reached'
    ?'Slide storage budget reached. Retry an already uploaded slide using Retry saved slide below; another upload is not needed.'
    :message==='Hourly submission limit reached'
      ?'Hourly submission limit reached. Please wait before submitting another slide.'
      :'The submission limit was reached. Please try again later.';
}
