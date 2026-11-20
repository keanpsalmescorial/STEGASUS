import { createClient } from 'npm:@supabase/supabase-js@2.49.4';
import { S3Client,HeadBucketCommand,CreateMultipartUploadCommand,UploadPartCommand,ListPartsCommand,CompleteMultipartUploadCommand,AbortMultipartUploadCommand,HeadObjectCommand,GetObjectCommand,PutObjectCommand,DeleteObjectCommand } from 'npm:@aws-sdk/client-s3@3.750.0';
import { getSignedUrl } from 'npm:@aws-sdk/s3-request-presigner@3.750.0';
import { FetchHttpHandler } from 'npm:@smithy/fetch-http-handler@5.0.4';
import { finalizeUpload } from './finalize.mjs';
import { checkedProgress } from './progress.mjs';
import { retryState,submissionLimitMessage } from './retry.mjs';
import { Problem,insist,checkedId,checkUpload,partLength,verifyParts,checkResult,artifactKey,PART_SIZE,FROZEN_THRESHOLD } from './validation.mjs';

const setting=(name:string)=>Deno.env.get(name)||'';
function required(name:string){const value=setting(name).trim();insist(value,503,'Inference service is awaiting configuration.');return value;}
function budget(name:string,fallback:number){const n=Number(setting(name)||fallback);insist(Number.isSafeInteger(n)&&n>0,503,'Inference limits are unavailable.');return n;}
const origins=()=>setting('STEGASUS_ALLOWED_ORIGINS').split(',').map(s=>s.trim()).filter(Boolean);
let storage:S3Client;
function r2(){return storage??=new S3Client({region:'auto',endpoint:'https://'+required('R2_ACCOUNT_ID')+'.r2.cloudflarestorage.com',requestHandler:new FetchHttpHandler({requestTimeout:15000}),maxAttempts:3,requestChecksumCalculation:'WHEN_REQUIRED',responseChecksumValidation:'WHEN_REQUIRED',credentials:{accessKeyId:required('R2_ACCESS_KEY_ID'),secretAccessKey:required('R2_SECRET_ACCESS_KEY')}});}
function bucket(){return required('R2_BUCKET');}
const maxFile=()=>Math.min(budget('MAX_FILE_BYTES',2*1024**3),PART_SIZE*10000);
function db(){return createClient(required('SUPABASE_URL'),required('SUPABASE_SERVICE_ROLE_KEY'),{auth:{persistSession:false,autoRefreshToken:false}});}
type Db=ReturnType<typeof db>;
function read<T>(r:{data:T,error:any}):T{if(r.error)throw new Problem(503,'The database could not complete the request.');return r.data;}
const now=()=>new Date().toISOString();
async function verifiedUser(client:Db,token:string){const {data,error}=await client.auth.getUser(token);insist(!error&&data.user,401,'Sign in to continue.');return data.user!.id;}
function workerScopes():Record<string,string>{
  const entries=setting('WORKER_SCOPES_JSON')?JSON.parse(setting('WORKER_SCOPES_JSON')):{[setting('WORKER_WORKSPACE_ID')]:setting('WORKER_TOKEN')};
  return Object.fromEntries(Object.entries(entries).filter(([id,t])=>id.length===36&&typeof t==='string'&&t.length>=32)) as Record<string,string>;
}
async function workerAuth(token:string){
  const digest=(s:string)=>crypto.subtle.digest('SHA-256',new TextEncoder().encode(s));
  const x=new Uint8Array(await digest(token));let scope='';
  for(const [id,expected] of Object.entries(workerScopes())){
    const y=new Uint8Array(await digest(expected));let diff=0;for(let i=0;i<x.length;i++)diff|=x[i]^y[i];
    if(diff===0)scope=id;
  }
  insist(scope,401,'Worker authentication failed.');return checkedId(scope);
}
async function access(client:Db,workspaceId:string,userId:string,write=false){
  const m=read(await client.from('workspace_members').select('role').eq('workspace_id',workspaceId).eq('user_id',userId).maybeSingle());
  insist(m&&(!write||['owner','administrator','researcher'].includes(m.role)),403,'Workspace access denied.');return m.role;
}
async function jobById(client:Db,id:string){const j=read(await client.from('inference_jobs').select('*').eq('id',checkedId(id)).maybeSingle());insist(j,404,'Analysis job is unavailable.');return j;}
function leased(client:Db,j:any,b:any){
  return client.from('inference_jobs').update(b).eq('id',j.id).eq('status','processing').eq('worker_id',j.worker_id).eq('lease_token',j.lease_token).gt('lease_until',now()).select('id').maybeSingle();
}
async function guardedUpdate(p:PromiseLike<any>){insist(read(await p),409,'The job state changed. Refresh and try again.');}
async function worker(client:Db,token:string,b:any){
  const scope=await workerAuth(token),workerId=b.workerId;
  insist(typeof workerId==='string'&&/^[\w.-]{1,100}$/.test(workerId),400,'Invalid worker identifier.');
  if(b.action==='worker-timing-profile'){
    insist(['frozen','direct'].includes(b.pipeline)&&Number.isSafeInteger(b.size)&&b.size>0,400,'Invalid timing request.');
    const rows=read(await client.from('inference_jobs').select('result').eq('workspace_id',scope).eq('worker_id',workerId).eq('status','completed').gte('size_bytes',Math.floor(b.size*.75)).lte('size_bytes',Math.ceil(b.size*1.25)).order('updated_at',{ascending:false}).limit(20));
    const times=rows.filter((r:any)=>r.result?.progress?.pipeline===b.pipeline&&Number.isFinite(r.result?.progress?.elapsedSeconds)&&r.result?.progress.elapsedSeconds>0).map((r:any)=>r.result?.progress.elapsedSeconds).sort((a:number,b:number)=>a-b);
    return {expectedSeconds:times.length>=3?times[Math.floor(times.length/2)]:null,samples:times.length};
  }
  if(b.action==='worker-storage-check'){
    try{
      await r2().send(new HeadBucketCommand({Bucket:bucket()}));
      const probe={Bucket:bucket(),Key:scope+'/checks/'+crypto.randomUUID()+'.tif'};
      const upload=await r2().send(new CreateMultipartUploadCommand({...probe,ContentType:'image/tiff'}));
      insist(upload.UploadId,503,'Storage could not start this upload.');
      await r2().send(new AbortMultipartUploadCommand({...probe,UploadId:upload.UploadId}));
      return {storageReady:true,multipartReady:true};
    }catch(error){
      const failure=error as any;
      return {storageReady:false,errorCode:typeof failure.name==='string'?failure.name.slice(0,80):'StorageError',httpStatus:failure.$metadata?.httpStatusCode??null,
        accountFormatValid:/^[a-f0-9]{32}$/i.test(setting('R2_ACCOUNT_ID')),
        accessKeyFormatValid:/^[a-f0-9]{32}$/i.test(setting('R2_ACCESS_KEY_ID')),
        secretFormatValid:/^[a-f0-9]{64}$/i.test(setting('R2_SECRET_ACCESS_KEY'))};
    }
  }
  if(b.action==='worker-claim'||b.action==='worker-heartbeat'){
    read(await client.from('inference_workers').upsert({workspace_id:scope,worker_id:workerId,last_seen:now()}));
    if(b.action==='worker-claim'){
      // Confirm signing configuration before acquiring a lease.
      const s=r2(),Bucket=bucket();
      const rows=read(await client.rpc('claim_inference',{p_workspace:scope,p_worker:workerId}));
      if(!rows?.length)return {job:null};const j=rows[0];
      const downloadUrl=await getSignedUrl(s,new GetObjectCommand({Bucket,Key:j.object_key}),{expiresIn:900});
      return {job:{id:j.id,workspace_id:scope,project_id:j.project_id,filename:j.filename,size_bytes:j.size_bytes,lease_token:j.lease_token,downloadUrl}};
    }
    if(!b.jobId)return {ok:true};
  }
  const j=await jobById(client,b.jobId);
  insist(j.workspace_id===scope&&j.worker_id===workerId&&j.lease_token===checkedId(b.leaseToken),403,'Worker lease is unavailable.');
  if(b.action==='worker-complete'&&j.status==='completed')return {ok:true};
  insist(j.status==='processing'&&Date.parse(j.lease_until)>Date.now(),409,'Worker lease expired.');
  if(b.action==='worker-heartbeat'){
    await guardedUpdate(leased(client,j,{updated_at:now(),lease_until:new Date(Date.now()+300000).toISOString(),...(b.progress?{result:{progress:checkedProgress(b.progress,now())}}:{})}));return {ok:true};
  }
  if(b.action==='worker-artifact'){
    const key=artifactKey(j,b.kind,b.mimeType);
    return {key,uploadUrl:await getSignedUrl(r2(),new PutObjectCommand({Bucket:bucket(),Key:key,ContentType:b.mimeType}),{expiresIn:600})};
  }
  if(b.action==='worker-fail'){
    // Keep private OS paths, local configuration and stack traces in the worker log.
    await guardedUpdate(leased(client,j,{status:'failed',error:'The laboratory worker could not process this slide. Review the local processing log.',lease_until:null,updated_at:now()}));return {ok:true};
  }
  insist(b.action==='worker-complete',400,'Unknown worker action.');checkResult(b.result);
  const artifacts=b.artifacts??[];insist(Array.isArray(artifacts)&&artifacts.length<=4,400,'Invalid artifacts.');
  const kinds=new Set();
  for(const a of artifacts){
    insist(a.key===artifactKey(j,a.kind,a.mimeType)&&!kinds.has(a.kind),400,'Invalid artifact provenance.');kinds.add(a.kind);
    const head=await r2().send(new HeadObjectCommand({Bucket:bucket(),Key:a.key}));insist(head.ContentLength&&head.ContentType===a.mimeType,409,'Artifact upload is incomplete.');
  }
  await guardedUpdate(leased(client,j,{status:'completed',updated_at:now(),lease_until:null,result:{...(b.progress?{progress:checkedProgress(b.progress,now())}:{}),score:b.result.score,threshold:FROZEN_THRESHOLD,modelVersion:b.result.modelVersion,patchCount:b.result.patchCount,expertScores:b.result.expertScores,inputSha256:b.result.inputSha256,classification:b.result.score>=FROZEN_THRESHOLD?'Flagged':'Below threshold'},artifacts:artifacts.map(({kind,key,mimeType}:any)=>({kind,key,mimeType}))}));
  return {ok:true};
}

async function listParts(j:any){
  const parts:any[]=[];let marker:string|undefined;
  do{const page=await r2().send(new ListPartsCommand({Bucket:bucket(),Key:j.object_key,UploadId:j.upload_id,PartNumberMarker:marker}));parts.push(...(page.Parts??[]));marker=page.IsTruncated?page.NextPartNumberMarker:undefined;}while(marker);
  return parts;
}
async function headSize(key:string){
  try{return (await r2().send(new HeadObjectCommand({Bucket:bucket(),Key:key}))).ContentLength;}
  catch(e){if((e as any)?.$metadata?.httpStatusCode===404)return null;throw e;}
}
async function userAction(client:Db,userId:string,b:any){
  const action=b.action;
  if(action==='availability'||action==='begin'){
    const wid=checkedId(b.workspaceId);
    const memberRole=await access(client,wid,userId,action==='begin');
    const w=read(await client.from('inference_workers').select('last_seen').eq('workspace_id',wid).gte('last_seen',new Date(Date.now()-120000).toISOString()).limit(1));
    const configured=!!(setting('R2_BUCKET')&&setting('R2_ACCOUNT_ID')&&setting('R2_ACCESS_KEY_ID')&&setting('R2_SECRET_ACCESS_KEY')&&workerScopes()[wid]);
    if(action==='availability'){
      let retryableJobIds:string[]=[];
      if(['owner','administrator','researcher'].includes(memberRole)){
        let query=client.from('inference_jobs').select('id').eq('workspace_id',wid).eq('status','failed').eq('object_present',true);
        if(!['owner','administrator'].includes(memberRole))query=query.eq('created_by',userId);
        retryableJobIds=read(await query.order('created_at',{ascending:false}).limit(100)).map((j:any)=>j.id);
      }
      return {configured,online:!!w?.length,limit:maxFile(),retryableJobIds};
    }
    insist(configured,503,'This laboratory has no configured inference service.');
    checkUpload(b,maxFile());const pid=checkedId(b.projectId);
    const project=read(await client.from('projects').select('id').eq('id',pid).eq('workspace_id',wid).maybeSingle());insist(project,404,'Choose a project in this workspace.');
    const id=crypto.randomUUID(),Key=wid+'/'+id+'/slide.tif',Bucket=bucket();
    const reservation=await client.rpc('reserve_inference',{p_id:id,p_workspace:wid,p_project:pid,p_user:userId,p_case:b.caseId.trim(),p_file:b.filename,p_size:b.size,p_workspace_limit:budget('WORKSPACE_UPLOAD_BYTES',4*1024**3),p_global_limit:budget('GLOBAL_UPLOAD_BYTES',8*1024**3)});
    if(reservation.error?.code==='P0001')throw new Problem(429,submissionLimitMessage(reservation.error.message));
    read(reservation);let uploadId;
    try{
      const created=await r2().send(new CreateMultipartUploadCommand({Bucket,Key,ContentType:'image/tiff'}));uploadId=created.UploadId;insist(uploadId,503,'Storage could not start this upload.');
      read(await client.from('inference_jobs').update({upload_id:uploadId}).eq('id',id));return {jobId:id,partSize:PART_SIZE};
    }catch(e){
      if(uploadId)await r2().send(new AbortMultipartUploadCommand({Bucket,Key,UploadId:uploadId})).catch(()=>{});
      await client.from('inference_jobs').update({status:'failed',error:'Upload initialization failed.',updated_at:now()}).eq('id',id);throw e;
    }
  }
  const j=await jobById(client,b.jobId),role=await access(client,j.workspace_id,userId,!['result-files'].includes(action));
  if(action==='result-files'){
    insist(j.status==='completed',409,'This analysis has no completed result.');
    const assets=await Promise.all(j.artifacts.map(async(a:any)=>({kind:a.kind,mimeType:a.mimeType,url:await getSignedUrl(r2(),new GetObjectCommand({Bucket:bucket(),Key:a.key}),{expiresIn:300})})));return {assets};
  }
  insist(j.created_by===userId||['owner','administrator'].includes(role),403,'Only the submitting researcher or a workspace administrator may manage this upload.');
  if(action==='retry'){
    insist(j.status==='failed'&&j.object_present,409,'This analysis has no failed, verified slide to retry.');
    const patch=retryState(j,await headSize(j.object_key),now());
    // Fenced, atomic transition: simultaneous clicks cannot enqueue two attempts,
    // and stale workers cannot write with the cleared lease token.
    await guardedUpdate(client.from('inference_jobs').update(patch).eq('id',j.id).eq('status','failed').eq('object_present',true).select('id').maybeSingle());
    return {ok:true};
  }
  if(action==='finish'&&['queued','processing','completed'].includes(j.status))return {ok:true};
  if(action==='link-experiment'){
    const eid=checkedId(b.experimentId);
    const exp=read(await client.from('experiments').select('id').eq('id',eid).eq('workspace_id',j.workspace_id).eq('project_id',j.project_id).maybeSingle());
    insist(exp,404,'Choose an experiment belonging to this project.');
    await guardedUpdate(client.from('inference_jobs').update({experiment_id:eid}).eq('id',j.id).eq('status','completed').select('id').maybeSingle());return {ok:true};
  }
  insist((j.status==='uploading'||(action==='cancel'&&j.status==='cancelled'))&&j.upload_id,409,'This upload is no longer open.');
  const params={Bucket:bucket(),Key:j.object_key,UploadId:j.upload_id};
  if(action==='part'){
    const size=partLength(j.size_bytes,b.partNumber);return {uploadUrl:await getSignedUrl(r2(),new UploadPartCommand({...params,PartNumber:b.partNumber,ContentLength:size}),{expiresIn:600})};
  }
  if(action==='cancel'){
    // First win the state transition. A concurrent finisher cannot enqueue a cancelled job.
    if(j.status!=='cancelled')await guardedUpdate(client.from('inference_jobs').update({status:'cancelled',updated_at:now()}).eq('id',j.id).eq('status','uploading').select('id').maybeSingle());
    try{await r2().send(new AbortMultipartUploadCommand(params));}catch(e){if((e as any)?.name!=='NoSuchUpload')throw e;}
    await r2().send(new DeleteObjectCommand({Bucket:params.Bucket,Key:params.Key}));return {ok:true};
  }
  insist(action==='finish',400,'Unknown upload action.');
  await finalizeUpload(j,{
    head:()=>headSize(j.object_key),
    parts:()=>listParts(j),
    complete:(parts:any[])=>r2().send(new CompleteMultipartUploadCommand({...params,MultipartUpload:{Parts:parts.map(p=>({PartNumber:p.PartNumber,ETag:p.ETag}))}}))
  });
  await guardedUpdate(client.from('inference_jobs').update({status:'queued',upload_id:null,object_present:true,updated_at:now()}).eq('id',j.id).eq('status','uploading').select('id').maybeSingle());
  return {ok:true};
}

Deno.serve(async req=>{
  let action='unknown';
  const origin=req.headers.get('Origin');
  const headers:Record<string,string>={'Content-Type':'application/json','Cache-Control':'no-store','Vary':'Origin'};
  if(origin&&origins().includes(origin)){headers['Access-Control-Allow-Origin']=origin;headers['Access-Control-Allow-Methods']='POST, OPTIONS';headers['Access-Control-Allow-Headers']='authorization, apikey, content-type, x-client-info';}
  const respond=(status:number,obj:unknown)=>new Response(JSON.stringify(obj),{status,headers});
  try {
    insist(!origin||origins().includes(origin),403,'Origin is unavailable.');
    if(req.method==='OPTIONS')return new Response(null,{status:204,headers});
    insist(req.method==='POST',405,'Use POST.');
    const token=(req.headers.get('Authorization')??'').match(/^Bearer (\S+)$/i)?.[1];insist(token,401,'Authentication required.');
    const reader=req.body?.getReader();insist(reader,400,'Missing request body.');
    const chunks:Uint8Array[]=[];let length=0;
    while(true){const {done,value}=await reader!.read();if(done)break;length+=value.length;if(length>65536){await reader!.cancel();throw new Problem(413,'Request too large.');}chunks.push(value);}
    let b;try{b=JSON.parse(await new Blob(chunks as BlobPart[]).text());}catch{throw new Problem(400,'Invalid JSON.');}
    insist(typeof b?.action==='string',400,'Missing action.');
    action=b.action;
    const client=db();const result=b.action.startsWith('worker-')?await worker(client,token!,b):await userAction(client,await verifiedUser(client,token!),b);
    return respond(200,result);
  }catch(e){
    if(!(e instanceof Problem))console.error(JSON.stringify({event:'inference_request_failed',action:action.slice(0,50),name:String((e as any)?.name??'Error').replace(/[^\w.-]/g,'').slice(0,80),httpStatus:(e as any)?.$metadata?.httpStatusCode??null}));
    return respond(e instanceof Problem?e.status:503,{error:e instanceof Problem?e.message:action==='finish'?'Slide storage finalization failed. Your upload has been kept; use Confirm upload and queue to retry.':'Inference service temporarily unavailable.'});
  }
});
