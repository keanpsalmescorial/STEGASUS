import {progressView} from './progress.mjs';
import {reportHtml} from './analysis-report.mjs';
const jobFields = 'id,case_id,filename,status,size_bytes,created_at,updated_at,result,error,experiment_id';
const writableRoles = ['owner','administrator','researcher'];

function node(tag,text,attributes={}) {
  const el=document.createElement(tag);
  if(text!==undefined)el.textContent=text;
  for(const [key,value] of Object.entries(attributes))el.setAttribute(key,value);
  return el;
}
function actionButton(label,listener) {
  const b=node('button',label,{type:'button'});b.addEventListener('click',listener);return b;
}
function field(caption,input) {
  const l=node('label');l.append(node('span',caption),input);return l;
}
function csvValue(value) {
  const s=String(value??'');const safe=/^\s*[=+@-]/.test(s)?"'"+s:s;
  return '"'+safe.replaceAll('"','""')+'"';
}
function download(name,content,type) {
  const url=URL.createObjectURL(new Blob([content],{type}));
  const link=node('a',undefined,{href:url,download:name});link.click();
  setTimeout(()=>URL.revokeObjectURL(url),5000);
}
function transfer(url,blob,onProgress,signal) {
  return new Promise((resolve,reject)=>{
    if(signal.aborted){reject(new Error('Transfer stopped.'));return;}
    const xhr=new XMLHttpRequest(),abort=()=>xhr.abort();
    signal.addEventListener('abort',abort,{once:true});
    xhr.upload.onprogress=e=>onProgress(e.loaded);
    xhr.onload=()=>xhr.status>=200&&xhr.status<300?resolve():reject(new Error('Storage declined an upload part.'));
    xhr.onerror=()=>reject(new Error('Storage transfer failed. Check your connection and storage CORS.'));
    xhr.onabort=()=>reject(new Error('Transfer stopped.'));
    xhr.onloadend=()=>signal.removeEventListener('abort',abort);
    xhr.open('PUT',url);xhr.send(blob);
  });
}
export async function mountAnalysis(container,{client,workspaceId,projectId,role}) {
  if(!document.querySelector('link[data-analysis-style]')){
    document.head.append(node('link',undefined,{rel:'stylesheet',href:new URL('./analysis.css',import.meta.url).href,'data-analysis-style':''}));
  }
  const section=node('section',undefined,{class:'analysis-studio'}), title=node('h2','AI Analysis Studio');
  container.replaceChildren(section);section.append(title,node('p','Choose a slide, follow its progress, and review your report and heatmap.'));
  const steps=node('ol',undefined,{class:'analysis-steps','aria-label':'Analysis workflow'});
  for(const label of ['Choose slide','Follow progress','Review report'])steps.append(node('li',label));
  section.append(steps);
  if(!workspaceId||!projectId){section.append(node('p','Select a workspace and a project to view or submit analysis jobs.'));return ()=>{};}
  let alive=true,timer,currentId=null,upload=null,busy=false,viewSequence=0,refreshing=false,selectedJobId=null,selectedJobStatus=null,initialLoad=true;
  const files=node('input',undefined,{type:'file',accept:'.tif,.tiff,image/tiff',required:''}), caseId=node('input',undefined,{maxlength:'100',placeholder:'Defaults to the slide filename'});
  const consent=node('input',undefined,{type:'checkbox',required:''}), declaration=node('label');
  declaration.append(consent,document.createTextNode(' I am authorized to submit this de-identified research tissue.'));
  const form=node('form'),status=node('p','Checking laboratory service.',{role:'status'}),feedback=node('p','',{role:'status'});
  const progress=node('progress',undefined,{max:'100',value:'0','aria-label':'Upload progress'}), drop=field('Drop a TIFF slide here or choose a file',files);
  const submit=node('button','Analyze slide',{type:'submit',disabled:''});
  let selected=null,service={configured:false,online:false,limit:0};
  const stop=actionButton('Cancel upload',async()=>{if(!upload)return;upload.abort();});
  stop.hidden=progress.hidden=true;
  const selection=node('p','');files.onchange=()=>{selected=files.files[0]??null;selection.textContent=selected?.name??'';};
  drop.ondragover=e=>e.preventDefault();drop.ondrop=e=>{e.preventDefault();if(busy)return;selected=e.dataTransfer.files[0]??null;files.required=!selected;selection.textContent=selected?.name??'';};
  const options=node('details');options.append(node('summary','Optional case label'),field('Case label',caseId));
  form.append(node('h3','Choose a slide'),drop,selection,options,declaration,submit,stop,progress);
  section.append(status);if(writableRoles.includes(role))section.append(form);
  const list=node('div'),detail=node('article'),refreshButton=actionButton('Refresh jobs',()=>refresh());
  const history=node('details',undefined,{class:'analysis-history'});history.append(node('summary','Previous analyses'),refreshButton,list);
  const again=actionButton('Analyze another slide',()=>{selectedJobId=null;selectedJobStatus=null;viewSequence++;detail.replaceChildren();form.hidden=!writableRoles.includes(role);again.hidden=true;files.focus();});again.hidden=true;
  section.append(feedback,detail,again,history,node('p','For investigational research use. Predictions and patch-score maps have no established clinical diagnostic or lesion-boundary validity.'));
  async function api(action,params={}) {
    const {data,error}=await client.functions.invoke('inference',{body:{action,...params}});
    if(error){
      let message;try{message=(await error.context?.clone().json())?.error;}catch{}
      throw new Error(message||'Inference service unavailable. Check sign-in and laboratory configuration.');
    }
    if(data?.error)throw new Error(data.error);return data;
  }
  function say(text){if(alive)feedback.textContent=text;}
  async function exportReport(j,button){
    button.disabled=true;const images=[];
    try{
      try{
        const {assets}=await api('result-files',{jobId:j.id});
        for(const a of assets.filter(a=>['heatmap','thumbnail'].includes(a.kind))){
          try{
            const response=await fetch(a.url,{credentials:'omit',referrerPolicy:'no-referrer'});if(!response.ok)continue;
            const blob=await response.blob();if(!['image/png','image/jpeg'].includes(blob.type))continue;
            const data=await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=reject;r.readAsDataURL(blob);});
            images.push({kind:a.kind,data});
          }catch{}
        }
      }catch{}
      download(j.id+'-report.html',reportHtml(j,images),'text/html;charset=utf-8');
      say(images.length===2?'Report downloaded with thumbnail and heatmap. Open it to print or save as PDF.':'Report downloaded. Some images could not be embedded; open the image files separately below.');
    }catch(e){say(e.message);}finally{button.disabled=false;}
  }
  function jobProgress(j){
    const view=progressView(j),box=node('div',undefined,{class:'job-progress','data-job-progress':j.id});
    box.append(node('span',view.label));
    if(['processing','queued','completed'].includes(j.status)){
      const bar=node('progress',undefined,{max:'100','aria-label':view.percent===null?'Processing activity':'Current stage progress'});
      if(view.percent!==null)bar.value=view.percent;
      box.append(bar);
    }
    box.append(node('small',view.eta));
    if(view.elapsed!==undefined)box.append(node('small',`${view.elapsed} min processing elapsed`));
    const age=(Date.now()-Date.parse(j.created_at))/1000;
    if(['processing','queued','uploading'].includes(j.status)&&age>300)box.append(node('small','Five-minute target exceeded; analysis continues.',{class:'target-exceeded'}));
    return box;
  }
  async function show(j) {
    selectedJobId=j.id;selectedJobStatus=j.status;
    form.hidden=!busy;again.hidden=busy||!writableRoles.includes(role);
    const sequence=++viewSequence;detail.replaceChildren(node('h3',j.status==='completed'?'Your analysis report':'Your slide analysis'),node('p',j.case_id+' / '+j.filename+' / '+new Date(j.updated_at).toLocaleString()));
    if(j.error)detail.append(node('p',j.error));
    detail.append(jobProgress(j));
    if(j.status==='uploading'&&!busy&&writableRoles.includes(role))detail.append(actionButton('Confirm upload and continue',async()=>{try{await api('finish',{jobId:j.id});await refresh();}catch(e){say(e.message);}}),actionButton('Cancel incomplete upload',async()=>{try{await api('cancel',{jobId:j.id});await refresh();}catch(e){say(e.message);}}));
    if(j.status!=='completed'||!j.result)return;
    const r=j.result,t=node('table');const header=node('tr');header.append(node('th','Result'),node('th','Value'));t.append(header);
    detail.append(node('p',r.classification,{class:'analysis-verdict'}),node('p','Ensemble score '+Number(r.score).toFixed(6)+' � threshold '+Number(r.threshold).toFixed(6)),node('p','This research flag requires human review. Below threshold does not rule out metastasis.'));
    const reportButton=actionButton('Download report',()=>exportReport(j,reportButton));detail.append(reportButton);
    const entries=[['Classification',r.classification],['Ensemble score',r.score],['Frozen threshold',r.threshold],['Tissue patches',r.patchCount],['Model version',r.modelVersion],...Object.entries(r.expertScores??{})];
    for(const [k,v] of entries){const row=node('tr');row.append(node('th',k,{scope:'row'}),node('td',String(v)));t.append(row);}
    const technical=node('details');technical.append(node('summary','Scores and research data'));detail.append(technical);
    technical.append(t,actionButton('Export result JSON',()=>download(j.id+'.json',JSON.stringify(j,null,2),'application/json')),actionButton('Export result CSV',()=>download(j.id+'.csv',[['case_id','filename','processed',...entries.map(x=>x[0])],[j.case_id,j.filename,j.updated_at,...entries.map(x=>x[1])]].map(row=>row.map(csvValue).join(',')).join('\r\n'),'text/csv')));
    try{
      const {assets}=await api('result-files',{jobId:j.id});if(!alive||sequence!==viewSequence)return;
      if(!assets.length)return;
      const gallery=node('div',undefined,{class:'analysis-images'});
      const zoom=node('input',undefined,{type:'range',min:'1',max:'4',step:'0.25',value:'1'});
      const images=[];
      for(const a of assets){
        if(!['https:'].includes(new URL(a.url).protocol))continue;
        const label={heatmap:'ResNet50 patch-score heatmap',thumbnail:'Tissue thumbnail',records:'Processing record',patch_scores:'Patch scores'}[a.kind]||a.kind;
        if(['thumbnail','heatmap'].includes(a.kind)){
          const f=node('figure'),pane=node('div',undefined,{class:'analysis-pan'}),img=node('img',undefined,{src:a.url,alt:label,referrerpolicy:'no-referrer'});
          pane.append(img);f.append(pane,node('figcaption',label));gallery.append(f);images.push(img);
        }
        detail.append(node('a','Open '+label.toLowerCase(),{href:a.url,target:'_blank',rel:'noopener noreferrer'}),document.createTextNode(' '));
      }
      if(images.length){zoom.oninput=()=>images.forEach(im=>im.style.width=Number(zoom.value)*100+'%');detail.append(field('Slide and heatmap zoom',zoom),gallery);}
    }catch(e){if(alive&&sequence===viewSequence)detail.append(node('p',e.message));}
  }
  async function refresh(){
    if(refreshing||!alive)return;refreshing=true;
    try{
      const [{data,error},availability]=await Promise.all([
        client.from('inference_jobs').select(jobFields).eq('workspace_id',workspaceId).eq('project_id',projectId).order('created_at',{ascending:false}).limit(100),
        api('availability',{workspaceId}).catch(()=>({configured:false,online:false,limit:0}))
      ]);
      if(!alive)return;service=availability;
      status.textContent=!service.configured?'Inference unavailable. The laboratory service requires configuration.':service.online?'Laboratory worker online.':'Laboratory worker offline. Submissions will remain queued.';
      submit.disabled=busy||!service.configured;if(error)throw new Error('Analysis history could not be loaded.');
      list.replaceChildren();if(!data.length){list.append(node('p','No analysis jobs in this project.'));return;}
      const table=node('table'),head=node('tr');for(const h of ['Case','Slide','Status','Submitted'])head.append(node('th',h));table.append(head);
      for(const j of data){
        const row=node('tr'),cell=node('td'),state=node('td');state.append(jobProgress(j));cell.append(actionButton(j.case_id,()=>show(j)));row.append(cell,node('td',j.filename),state,node('td',new Date(j.created_at).toLocaleDateString()));table.append(row);
        if(j.status==='uploading'&&writableRoles.includes(role)&&j.id!==currentId){
          const c=node('td');
          const recover=actionButton('Confirm upload and queue',async()=>{
            recover.disabled=true;
            try{await api('finish',{jobId:j.id});say('Upload verified. The slide is queued for laboratory analysis.');await refresh();}
            catch(e){say('Upload could not be confirmed: '+e.message);}
            finally{recover.disabled=false;}
          });
          c.append(recover,actionButton('Cancel incomplete upload',async()=>{try{await api('cancel',{jobId:j.id});await refresh();}catch(e){say(e.message);}}));row.append(c);
        }
      }
      list.append(table);
      if(initialLoad){initialLoad=false;const active=data.find(j=>['processing','queued','uploading'].includes(j.status));if(active)selectedJobId=active.id;}
      const selectedJob=data.find(j=>j.id===selectedJobId);
      if(selectedJob){
        if(selectedJob.status!==selectedJobStatus)await show(selectedJob);
        else detail.querySelector('[data-job-progress]')?.replaceWith(jobProgress(selectedJob));
      }
    }catch(e){if(alive)list.replaceChildren(node('p',e.message));}finally{refreshing=false;}
  }
  form.onsubmit=async e=>{
    e.preventDefault();if(busy)return;
    if(!service.configured||!selected||!consent.checked){say('Choose a TIFF slide and confirm authorization.');return;}
    if(!/\.tiff?$/i.test(selected.name)||selected.size<1||selected.size>service.limit){say('Choose a nonempty TIFF slide within the '+Math.floor(service.limit/1024**2)+' MiB limit.');return;}
    const file=selected,controller=new AbortController();upload=controller;busy=true;submit.disabled=files.disabled=caseId.disabled=consent.disabled=true;progress.hidden=stop.hidden=false;progress.value=0;
    let submitted=false,finishing=false;const uploadStarted=performance.now();
    try{
      const begin=await api('begin',{workspaceId,projectId,caseId:(caseId.value.trim()||file.name.replace(/\.tiff?$/i,'')).slice(0,100),authorized:true,filename:file.name,size:file.size});currentId=begin.jobId;selectedJobId=currentId;
      for(let offset=0,part=1;offset<file.size;offset+=begin.partSize,part++){
        const bytes=file.slice(offset,Math.min(offset+begin.partSize,file.size));
        for(let attempt=0;;attempt++){
          if(controller.signal.aborted)throw new Error('Transfer stopped.');
          try{const {uploadUrl}=await api('part',{jobId:currentId,partNumber:part});await transfer(uploadUrl,bytes,count=>{
            const sent=offset+count,elapsed=(performance.now()-uploadStarted)/1000;progress.value=sent/file.size*100;
            say(`Uploading: ${Math.floor(progress.value)}%. `+(elapsed>=5&&sent>0?`About ${Math.max(1,Math.ceil(elapsed*(file.size-sent)/sent/60))} min remaining for upload.`:'Calculating upload time.'));
          },controller.signal);break;}
          catch(err){if(attempt>=2||controller.signal.aborted)throw err;say('Retrying part '+part+'.');}
        }
      }
      finishing=true;stop.hidden=true;
      await api('finish',{jobId:currentId});submitted=true;say('Upload verified. The slide is queued for laboratory analysis.');
      form.reset();selected=null;selection.textContent='';files.required=true;
    }catch(err){
      if(currentId&&finishing){try{await api('finish',{jobId:currentId});submitted=true;say('Upload verified. Analysis submitted.');}catch(retryError){say('Could not confirm submission: '+retryError.message+' Use Confirm upload and queue in job history to retry without re-uploading.');}}
      else say(err.message);
      if(currentId&&!submitted&&!finishing){try{await api('cancel',{jobId:currentId});}catch{say('Transfer interrupted. Cancel the incomplete upload in job history.');}}
    }finally{
      currentId=null;upload=null;busy=false;files.disabled=caseId.disabled=consent.disabled=false;stop.hidden=progress.hidden=true;submit.disabled=!service.configured;form.hidden=Boolean(selectedJobId);again.hidden=!selectedJobId||!writableRoles.includes(role);await refresh();
    }
  };
  await refresh();if(alive)timer=setInterval(()=>{if(!section.isConnected){dispose();return;}if(!document.hidden)refresh();},5000);
  function dispose(){alive=false;viewSequence++;clearInterval(timer);upload?.abort();}
  return dispose;
}
