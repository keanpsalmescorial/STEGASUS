import {el,p,panel,button,select,form,accordion,table,dataGrid,exportsFor,chart,download} from './ui.mjs';
import {readCsv,validateRows,columns,numeric,describe,classify,toCsv} from './data.mjs';
const app=document.querySelector('#app'), notice=document.querySelector('#notice');
let client,session,workspace=null,role='',projectId='',experimentId='',datasetId='',view='AI Analysis Studio',version=0,cleanup;
let workspaces=[],projects=[],experiments=[],datasets=[];
const templates=[['pathology','Computational pathology laboratory'],['ml','Machine learning research team'],['general','General research laboratory'],['personal','Personal research workspace']];
const pages=['Dashboard','Projects','Experiments','Datasets','AI Analysis Studio','Results Library','Analytics','Reports','Team Members','Settings'];
const readWrite=()=>['owner','administrator','researcher'].includes(role);
const manage=()=>['owner','administrator'].includes(role);
const info=t=>{notice.textContent=t;notice.hidden=!t;};
const take=async req=>{const {data,error}=await req;if(error)throw Error(error.message);return data;};
const rpc=(name,args)=>take(client.rpc(name,args));
const fmt=v=>v===null||v===undefined?'-':Number(v).toLocaleString(undefined,{maximumFractionDigits:4});
const when=v=>v?new Date(v).toLocaleString():'-';
const activeProject=()=>projects.find(r=>r.id===projectId);
const activeExp=()=>experiments.find(r=>r.id===experimentId&&r.project_id===projectId);
async function rows(name,filter={},fields='*',order='id') {
 const result=[];
 for(let start=0;;start+=500){
  let query=client.from(name).select(fields);
  for(const [key,value] of Object.entries(filter))query=query.eq(key,value);
  const batch=await take(query.order(order).range(start,start+499));
  result.push(...batch);if(batch.length<500)return result;
 }
}
const scoped=(name,filter={},fields='*')=>rows(name,{workspace_id:workspace.id,...filter},fields);
async function writeRecord(name,record){await take(client.from(name).insert({workspace_id:workspace.id,...record}));await refresh();}
const navigate=name=>{view=name;info('');refresh();};
function noService(reason){
 app.replaceChildren(authLayout(panel('Workspace access unavailable',p(reason,'access-note'),p('The public research website includes the study methods, published results, and limitations.'),el('a',{href:'../#results'},'Explore published results'))));
}
function authLayout(content){return el('main',{class:'auth',id:'main'},el('section',{class:'auth-art'},el('div',{class:'grid-art','aria-hidden':'true'}),p('STEGASUS','eyebrow'),el('h1',{},'Research Studio'),p('Organize experimental runs, compare measurements, and review computational pathology results with your laboratory.')),el('section',{},content));}
function auth(mode='Sign in'){
 ++version;cleanup?.();cleanup=null;
 const recovery=mode==='Set password';
 const labels=recovery?[]:['Sign in','Register','Reset password'];
 const tabs=el('div',{class:'tabs'},...labels.map(label=>{const b=button(label,()=>auth(label));b.setAttribute('aria-pressed',String(mode===label));return b;}));
 const fields=[];
 if(mode==='Register')fields.push(['display_name','Display name','text',true]);
 if(!recovery)fields.push(['email','Email address','email',true]);
 if(mode!=='Reset password')fields.push([mode==='Register'||recovery?'new_password':'password',recovery?'New password':'Password','password',true]);
 const redirect=new URL('./',location.href).href;
 const authForm=form(fields,mode,async f=>{
   const email=f.email?.trim();
   if(mode==='Sign in'){await take(client.auth.signInWithPassword({email,password:f.password}));}
   if(mode==='Register'){await take(client.auth.signUp({email,password:f.new_password,options:{data:{display_name:f.display_name.trim()},emailRedirectTo:redirect}}));info('Registration submitted. Check your email for a confirmation link if required.');}
   if(mode==='Reset password'){await take(client.auth.resetPasswordForEmail(email,{redirectTo:redirect}));info('If the address is registered, a password-reset link will arrive by email.');}
   if(recovery){await take(client.auth.updateUser({password:f.new_password}));info('Your password has been updated.');await refresh();}
 });
 app.replaceChildren(authLayout(el('div',{},el('h2',{},mode),tabs,authForm)));
}
function createSpace(){return form([['name','Workspace name','text',true],['template','Workspace type','select',true,templates]],'Create workspace',async f=>{
 const id=await rpc('create_workspace',{p_name:f.name.trim(),p_template:f.template});workspace={id};projectId='';experimentId='';datasetId='';view='AI Analysis Studio';await refresh();
});}
function acceptInvite(){return form([['token','Invitation token','text',true]],'Join workspace',async f=>{const id=await rpc('accept_invitation',{p_token:f.token.trim()});workspace={id};projectId='';experimentId='';datasetId='';view='AI Analysis Studio';await refresh();});}
async function refresh(){
 const rev=++version;
 cleanup?.();cleanup=null;
 if(!session){auth();return;}
 const root=el('main',{id:'main',class:'workspace'},p('Loading workspace.','muted'));
 app.replaceChildren(root);
 try{
 const choices=await rows('workspaces',{},'id,name,template');
 if(rev!==version)return;workspaces=choices;
 workspace=choices.find(w=>w.id===workspace?.id)||choices[0];
 if(!workspace){root.replaceChildren(el('h1',{},'Set up your workspace'),panel('Create a laboratory workspace',createSpace()),panel('Accept a team invitation',acceptInvite()),signOut());return;}
 const id=workspace.id,uid=session.user.id;
 const [members,pr,ex,ds]=await Promise.all([rows('workspace_members',{workspace_id:id,user_id:uid},'role','user_id'),scoped('projects'),scoped('experiments'),scoped('datasets',{},'id,name,description,created_at')]);
 if(rev!==version)return;role=members[0]?.role??'';projects=pr;experiments=ex;datasets=ds;
 projectId=projects.some(x=>x.id===projectId)?projectId:projects[0]?.id||'';
 experimentId=activeExp()?.id||experiments.find(x=>x.project_id===projectId)?.id||'';
 datasetId=datasets.some(x=>x.id===datasetId)?datasetId:datasets[0]?.id||'';
 const side=el('aside',{},select('Workspace',choices.map(x=>[x.id,x.name]),id,v=>{workspace={id:v};projectId='';experimentId='';datasetId='';refresh();}),p(role,'muted'),el('nav',{'aria-label':'Workspace navigation'},button('Analyze slide',()=>navigate('AI Analysis Studio'),view==='AI Analysis Studio'?'active':''),button('Results library',()=>navigate('Results Library'),view==='Results Library'?'active':''),accordion('Workspace tools',...pages.filter(v=>!['AI Analysis Studio','Results Library'].includes(v)).map(v=>button(v,()=>navigate(v),v===view?'active':'')))),signOut());
 const content=el('div');root.replaceChildren(p(templates.find(t=>t[0]===workspace.template)?.[1]||workspace.name,'eyebrow'),el('h1',{},view),content);
 const shell=el('div',{class:'shell'},side,root);app.replaceChildren(shell);
 await renderView(content,rev);
 }catch(err){if(rev===version)root.replaceChildren(el('h1',{},'Workspace could not load'),p(err.message,'error'),button('Try again',refresh),signOut());}
}
function signOut(){return button('Sign out',async()=>{try{await take(client.auth.signOut());info('Signed out.');}catch(e){info(e.message);}});}
function selectors(includeExperiment=false){
 const choices=[select('Project',projects.map(x=>[x.id,x.name]),projectId,v=>{projectId=v;experimentId='';refresh();})];
 if(includeExperiment)choices.push(select('Experiment',experiments.filter(x=>x.project_id===projectId).map(x=>[x.id,x.name]),experimentId,v=>{experimentId=v;refresh();}));
 return el('div',{class:'selectors'},...choices);
}
function metrics(items){return el('div',{class:'metrics'},...items.map(([k,v])=>el('div',{class:'metric'},el('strong',{},String(v)),k)));}
async function renderView(node,rev){
 if(view==='Dashboard'){
  const [runs,activity,jobs]=await Promise.all([scoped('experiment_runs',{},'id,name'),take(client.from('activity_logs').select('entity,action,created_at').eq('workspace_id',workspace.id).order('created_at',{ascending:false}).limit(10)),take(client.from('inference_jobs').select('id,status,created_at').eq('workspace_id',workspace.id).order('created_at',{ascending:false}).limit(6))]);
  node.append(p(workspace.name),metrics([['Projects',projects.length],['Experiments',experiments.length],['Recorded runs',runs.length],['Datasets',datasets.length]]),panel('Recent analysis jobs',jobs.length?table(['Job','Status','Submitted'],jobs.map(j=>[j.id,j.status,when(j.created_at)])):p('No analysis jobs yet.')),panel('Recent team activity',activity.length?table(['Record','Action','Time'],activity.map(a=>[a.entity,a.action,when(a.created_at)])):p('No activity recorded.')));
 }else if(view==='Projects'){
  if(readWrite())node.append(accordion('Create project',form([['name','Project name','text',true],['objectives','Research objectives','textarea']],'Save project',f=>writeRecord('projects',f))));
  node.append(panel('Workspace projects',projects.length?table(['Project','Objectives','Experiments'],projects.map(r=>[button(r.name,()=>{projectId=r.id;experimentId='';navigate('Experiments');}),r.objectives,experiments.filter(e=>e.project_id===r.id).length])):p('No projects recorded.')));
 }else if(view==='Team Members')await team(node);
 else if(view==='Settings')await settings(node);
 else if(view==='Datasets')await datasetView(node);
 else if(view==='AI Analysis Studio'){
  if(projects.length>1)node.append(accordion('Save location',selectors()));
  if(!projectId){
    node.append(p('Enable slide analysis to save your reports in this workspace.'));
    if(readWrite())node.append(button('Enable slide analysis',async()=>{try{const {data,error}=await client.from('projects').insert({workspace_id:workspace.id,name:'Slide analyses',objectives:'Slide analysis reports and visualizations.'}).select('id').single();if(error)throw error;projectId=data.id;await refresh();}catch(e){info(e.message);}}));
    return;
  }
  const here=el('div');node.append(here);
  const {mountAnalysis}=await import('./analysis.js?v=saved-retry-1');if(rev!==version)return;
  const dispose=await mountAnalysis(here,{client,workspaceId:workspace.id,projectId,role,user:session.user});
  if(rev!==version)dispose?.();else cleanup=dispose;
 }else if(view==='Results Library'){
  node.append(panel('Published STEGASUS results',p('Versioned reference records from the November 2026 manuscript.'),el('a',{href:'../#results'},'Open published research results')),panel('Workspace results',p('Review recorded runs, datasets, and predictions for '+workspace.name+'.'),el('div',{class:'actions'},...['Experiments','Datasets','AI Analysis Studio'].map(x=>button(x,()=>navigate(x))))));
 }else if(view==='Experiments')await experimentView(node);
 else if(view==='Reports')await report(node);
 else if(view==='Analytics')await analytics(node);
}
async function team(node){
 const members=await scoped('workspace_members',{},'user_id,role').catch(async()=>rows('workspace_members',{workspace_id:workspace.id},'user_id,role','user_id'));
 const profiles=await rows('profiles',{},'id,display_name');
 const labels=Object.fromEntries(profiles.map(x=>[x.id,x.display_name||x.id]));
 const assign=role==='owner'?['administrator','researcher','reviewer','viewer']:['researcher','reviewer','viewer'];
 node.append(panel('Workspace members',table(['Member','Role','Management'],members.map(m=>{
 const change=manage()&&m.user_id!==session.user.id&&m.role!=='owner'&&(role==='owner'||m.role!=='administrator');
 let actions=null;if(change)actions=accordion('Manage member',form([['role','Role','select',true,assign,m.role]],'Update role',async f=>{await rpc('set_member_role',{p_workspace_id:workspace.id,p_user_id:m.user_id,p_role:f.role});await refresh();}),form([['confirm','Type REMOVE to remove access','text',true]],'Remove access',async f=>{if(f.confirm!=='REMOVE')throw Error('Type REMOVE to confirm.');await rpc('remove_member',{p_workspace_id:workspace.id,p_user_id:m.user_id});await refresh();}));
 return [labels[m.user_id]||m.user_id,m.role,actions];
 }))));
 if(manage()){
 const result=el('div',{'aria-live':'polite'});
 node.append(panel('Invite a researcher',form([['email','Invited email address','email',true],['role','Access role','select',true,assign]],'Create invitation',async f=>{
 const token=await rpc('invite_member',{p_workspace_id:workspace.id,p_email:f.email.trim(),p_role:f.role});
 result.replaceChildren(p('Share this one-use token privately with the invited researcher.'),el('input',{readonly:true,value:token,'aria-label':'Invitation token'}));}),result));}
 node.append(accordion('Accept an invitation',acceptInvite()));
}
async function settings(node){
 const profile=await rows('profiles',{id:session.user.id},'id,display_name');
 node.append(panel('Researcher profile',form([['display_name','Display name','text',true,null,profile[0]?.display_name||'']],'Save profile',async f=>{await take(client.from('profiles').update({display_name:f.display_name.trim()}).eq('id',session.user.id));info('Profile saved.');})),panel('Workspace details',p(workspace.name),p(templates.find(([id])=>id===workspace.template)?.[1]||workspace.template,'muted')),accordion('Create another workspace',createSpace()),accordion('Join a workspace',acceptInvite()));
}


async function experimentView(node){
 node.append(selectors(true));
 if(!projectId){node.append(p('Create a project to start recording experiments.'));return;}
 if(readWrite())node.append(accordion('Create experiment',form([['name','Experiment title','text',true],['description','Description','textarea'],['objectives','Objectives','textarea'],['research_question','Research question','textarea'],['procedure_text','Procedure','textarea'],['conditions','Experimental conditions','textarea'],['notes','Protocol notes','textarea']],'Save experiment',f=>writeRecord('experiments',{project_id:projectId,...f}))));
 const exp=activeExp();if(!exp){node.append(p('No experiments recorded for this project.'));return;}
 const data=await experimentData(exp);
 node.append(panel(exp.name,...['description','objectives','research_question','procedure_text','conditions','notes'].filter(k=>exp[k]).map(k=>el('div',{},el('h3',{},({research_question:'Research question',procedure_text:'Procedure',notes:'Protocol notes'})[k]||k[0].toUpperCase()+k.slice(1)),p(exp[k],'entry')))));
 if(readWrite()){
 node.append(accordion('Define a variable',form([['name','Variable name','text',true],['kind','Data type','select',true,['numeric','categorical','text','datetime']],['unit','Measurement unit'],['variable_role','Variable role','select',true,['dependent','independent','controlled','other']]],'Save variable',f=>writeRecord('experiment_variables',{...f,experiment_id:exp.id}))));
 const variables=data.vars;
 const fields=[['name','Run or sample identifier','text',true],['replicate','Replicate number','number',true,null,1],['run_date','Run date and time','datetime-local',true],['configuration','Equipment and model configuration (JSON object)','textarea',false,null,'{}'],['notes','Run notes','textarea']];
 for(const v of variables)fields.push([v.id,v.name+(v.unit?' ('+v.unit+')':''),v.kind==='numeric'?'number':v.kind==='datetime'?'datetime-local':'text']);
 node.append(accordion('Record experimental run',form(fields,'Save run and measurements',async f=>{
 const config=JSON.parse(f.configuration||'{}');
 if(config===null||Array.isArray(config)||typeof config!=='object') throw Error('Configuration must be a JSON object.');
 const replicate=Number(f.replicate);if(!Number.isInteger(replicate)||replicate<1) throw Error('Replicate must be a positive integer.');
 const values=Object.fromEntries(variables.filter(v=>String(f[v.id]??'').trim()).map(v=>[v.id,v.kind==='numeric'?Number(f[v.id]):v.kind==='datetime'?new Date(f[v.id]).toISOString():f[v.id]]));
 await rpc('record_run',{p_workspace_id:workspace.id,p_experiment_id:exp.id,p_name:f.name.trim(),p_replicate:replicate,p_run_date:new Date(f.run_date).toISOString(),p_configuration:config,p_notes:f.notes,p_values:values});await refresh();
 })));
 }
 node.append(panel('Variables',data.vars.length?table(['Variable','Type','Unit','Role'],data.vars.map(v=>[v.name,v.kind,v.unit,v.variable_role])):p('No variables defined.')),panel('Run measurements',dataGrid(data.flat),exportsFor('experimental-runs',data.flat)));
 node.append(panel('Researcher and reviewer notes',...data.notes.map(n=>el('article',{},p(n.body,'entry'),p(when(n.created_at)+' � '+n.created_by,'muted'))),role!=='viewer'?form([['body','Add note','textarea',true]],'Save note',f=>writeRecord('research_notes',{experiment_id:exp.id,body:f.body})):null));
}
async function experimentData(exp) {
 const id={experiment_id:exp.id};
 const [vars,runs,ms,notes]=await Promise.all(['experiment_variables','experiment_runs','measurements','research_notes'].map(key=>scoped(key,id)));
 runs.sort((a,b)=>a.run_date.localeCompare(b.run_date));
 const byRun=new Map();
 for(const m of ms){if(!byRun.has(m.run_id))byRun.set(m.run_id,new Map());byRun.get(m.run_id).set(m.variable_id,m.value);}
 const flat=runs.map(r=>Object.fromEntries([['Run',r.name],['Replicate',r.replicate],['Run date',r.run_date],...vars.map(v=>['Variable � '+v.name+(v.unit?' ('+v.unit+')':''),byRun.get(r.id)?.get(v.id)??null])]));
 return {vars,runs,ms,notes,flat};
}
async function datasetView(node){
 if(readWrite())node.append(accordion('Import dataset',form([['name','Dataset name','text',true],['description','Description and provenance','textarea'],['file','CSV or JSON file','file',true]],'Import dataset',async f=>{
 if(f.file.size>2*1024*1024)throw Error('Choose a dataset smaller than 2 MiB.');
 const body=await f.file.text();let records;
 if(/\.csv$/i.test(f.file.name))records=readCsv(body);
 else if(/\.json$/i.test(f.file.name))records=validateRows(JSON.parse(body));
 else throw Error('Use CSV with a header row or a JSON array of records.');
 await writeRecord('datasets',{name:f.name,description:f.description,records});
 })));
 if(!datasets.length){node.append(p('No datasets saved.'));return;}
 node.append(select('Dataset',datasets.map(x=>[x.id,x.name]),datasetId,v=>{datasetId=v;refresh();}));
 const dataset=await take(client.from('datasets').select('*').eq('workspace_id',workspace.id).eq('id',datasetId).single());
 node.append(panel(dataset.name,p(dataset.description||''),p('Recorded '+when(dataset.created_at),'muted'),dataGrid(dataset.records),exportsFor('dataset',dataset.records)));
}
function summaryTable(data){
 const metrics=columns(data).map(k=>[k,describe(data.map(r=>r[k]))]).filter(([,s])=>s.count>0);
 return metrics.length?table(['Field','Numeric count','Mean','Sample SD','Minimum','Maximum'],metrics.map(([k,s])=>[k,s.count,fmt(s.mean),fmt(s.sd),fmt(s.min),fmt(s.max)])):p('No numeric measurements available.');
}
function analysisBoard(records){
 if(!records.length)return p('No records to analyze.');
 const keys=columns(records),numbers=keys.filter(k=>records.some(r=>numeric(r[k])!==null));
 const target=el('div'),visual=el('div'),thresholdResult=el('div');
 if(numbers.length){
 let x='',y=numbers.find(k=>k!=='Replicate')||numbers[0],kind='bar';
 const draw=()=>{const pts=records.map((r,i)=>[x?numeric(r[x]):i+1,numeric(r[y])]);visual.replaceChildren(chart(pts,kind,y,x||'Record number',y));};
 target.append(panel('Measurement chart',el('div',{class:'selectors'},select('Chart type',[['bar','Bar'],['line','Line'],['scatter','Scatter']],kind,v=>{kind=v;draw();}),select('Horizontal axis',[['','Record number'],...numbers.map(k=>[k,k])],x,v=>{x=v;draw();}),select('Vertical axis',numbers.map(k=>[k,k]),y,v=>{y=v;draw();})),visual));draw();
 }
 target.append(panel('Descriptive statistics',summaryTable(records)));
 if(numbers.length>=2)target.append(panel('Classification analysis',p('Select a recorded binary reference label and a prediction score. A score at or above the threshold counts as positive.'),form([['label','Reference label (0 or 1)','select',true,numbers],['score','Prediction score','select',true,numbers,numbers[1]],['threshold','Decision threshold','number',true,null,0.5]],'Calculate metrics',f=>{
 const s=classify(records,f.label,f.score,f.threshold);thresholdResult.replaceChildren(table(['Actual / predicted','Negative','Positive'],[['Negative',s.tn,s.fp],['Positive',s.fn,s.tp]]),metrics([['AUROC',fmt(s.auroc)],['Average precision',fmt(s.ap)],['Accuracy',fmt((s.tn+s.tp)/records.length)],['Sensitivity',fmt(s.tp+s.fn?s.tp/(s.tp+s.fn):null)],['Specificity',fmt(s.tn+s.fp?s.tn/(s.tn+s.fp):null)]]));
 if(s.roc.length)thresholdResult.append(chart(s.roc,'line','Receiver operating characteristic','False-positive rate','True-positive rate',true));if(s.pr.length)thresholdResult.append(chart(s.pr,'scatter','Precision-recall operating points','Recall','Precision',true));
 }),thresholdResult));
 return target;
}
async function analytics(node){
 node.append(selectors(true));
 const exp=activeExp();if(exp){const data=await experimentData(exp);node.append(panel(exp.name,analysisBoard(data.flat)));}else node.append(p('Select an experiment with recorded measurements for run analytics.'));
 if(datasets.length){node.append(select('Dataset analytics',datasets.map(d=>[d.id,d.name]),datasetId,v=>{datasetId=v;refresh();}));const ds=await take(client.from('datasets').select('name,records').eq('workspace_id',workspace.id).eq('id',datasetId).single());node.append(panel(ds.name,analysisBoard(ds.records)));}
}
async function report(node){
 node.append(selectors(true));const exp=activeExp();if(!exp){node.append(p('Select an experiment to prepare a report.'));return;}
 const data=await experimentData(exp);
 const full={workspace:{id:workspace.id,name:workspace.name},project:activeProject(),experiment:exp,variables:data.vars,runs:data.runs,measurements:data.ms,notes:data.notes,exported_at:new Date().toISOString()};
 node.append(el('div',{class:'actions'},button('Print report / save PDF',()=>window.print()),button('Download report JSON',()=>download('experiment-report.json',JSON.stringify(full,null,2),'application/json')),button('Download measurements CSV',()=>download('measurements.csv',toCsv(data.flat),'text/csv'))),panel(exp.name,p(workspace.name+' � '+activeProject().name),p(exp.description),p('Research question: '+(exp.research_question||'-')),p('Objectives: '+(exp.objectives||'-')),p('Procedure: '+(exp.procedure_text||'-')),p('Conditions: '+(exp.conditions||'-')),p('Recorded by '+exp.created_by+' on '+when(exp.created_at),'muted')),panel('Recorded observations',data.flat.length?table(columns(data.flat),data.flat.map(r=>columns(data.flat).map(k=>r[k]))):p('No recorded runs.')),panel('Descriptive statistics',summaryTable(data.flat)));
 for(const v of data.vars.filter(v=>v.kind==='numeric')){const key='Variable � '+v.name+(v.unit?' ('+v.unit+')':'');if(data.flat.some(r=>numeric(r[key])!==null))node.append(panel(v.name,chart(data.flat.map((r,i)=>[i+1,r[key]]),'bar',v.name,'Run in time order',v.unit||v.name)));}
 node.append(panel('Run provenance',table(['Run','Timestamp','Researcher','Configuration','Notes'],data.runs.map(r=>[r.name,when(r.run_date),r.created_by,JSON.stringify(r.configuration),r.notes]))),panel('Researcher interpretations',...data.notes.map(n=>p(n.body+' � '+when(n.created_at),'entry')),p(exp.notes||'')));
}
async function start(){
 const cfg=window.STEGASUS_CONFIG||{};
 if(!cfg.supabaseUrl||!cfg.supabaseAnonKey){noService('Private workspace access is offline. The site owner needs to connect the laboratory Supabase project before sign-in and analysis become available.');return;}
 try{
  const {createClient}=await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.49.4/+esm');
  client=createClient(cfg.supabaseUrl,cfg.supabaseAnonKey);
  let prior=null,recovering=false;
  client.auth.onAuthStateChange((event,s)=>{
   session=s;
   if(event==='PASSWORD_RECOVERY'){recovering=true;auth('Set password');return;}
   if(event==='SIGNED_OUT'){recovering=false;workspace=null;projectId=experimentId=datasetId='';view='AI Analysis Studio';info('');}
   if(event==='USER_UPDATED')recovering=false;
   const id=s?.user?.id||'';
   if(!recovering&&(prior!==id||event==='INITIAL_SESSION')){prior=id;setTimeout(()=>{if(!recovering)refresh();},0);}
  });
 }catch(err){noService('The authentication service could not load. Check the connection and reload the page.');}
}
start();
