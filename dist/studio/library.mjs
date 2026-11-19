import {el,p,panel,button,form,select,table,dataGrid,exportsFor,download} from './ui.mjs';
import {columns,describe} from './data.mjs';
export async function publishedPanel(){
 const response=await fetch('../data/manuscript.json');
 if(!response.ok)throw Error('The published research data could not be loaded.');
 const ref=await response.json(),tables=ref.tables.filter(t=>Number(t.number)>=4||t.number==='A1');
 const output=el('div');
 const choice=select('Published table',tables.map(t=>[String(t.number),'Table '+t.number+' � '+t.title]),String(tables[0].number),show);
 function show(number){
 const t=tables.find(r=>String(r.number)===number);
 const records=t.rows.map(row=>Object.fromEntries(t.columns.map((key,i)=>[key,row[i]])));
 output.replaceChildren(el('h3',{},t.title),dataGrid(records),exportsFor('STEGASUS-table-'+number,records));
 }
 show(String(tables[0].number));
 return panel('Published research results',p(ref.version+' � '+ref.source,'muted'),p('The sampled source-slide, selected whole-slide, and supplementary WILDS evaluations each use different units. Read the study limitations when interpreting these tables.'),choice,output,el('a',{href:'../#results'},'Read results and discussion'));
}
export async function attachmentPanel(client,exp,canWrite){
 const prefix=exp.workspace_id+'/'+exp.id,storage=client.storage.from('experiment-attachments');
 const listing=el('div'),details=panel('Experiment attachments',listing);
 async function list(){
 let files=[];for(let offset=0;;offset+=100){
 const {data,error}=await storage.list(prefix,{limit:100,offset,sortBy:{column:'name',order:'asc'}});if(error)throw Error(error.message);files.push(...data);if(data.length<100)break;}
 listing.replaceChildren(files.length?table(['File','Size','Download'],files.map(f=>{
 const label=f.name.replace(/^[0-9a-f-]{36}-/i,'');
 return [label,Number(f.metadata?.size??0).toLocaleString()+' bytes',button('Download',async e=>{const b=e.currentTarget;b.disabled=true;try{const {data,error}=await storage.download(prefix+'/'+f.name);if(error)throw Error(error.message);download(label,data,'application/octet-stream');}catch(err){listing.append(p(err.message,'error'));}finally{b.disabled=false;}})];
 })):p('No documents attached.'));
 }
 try{await list();}catch(err){listing.append(p('Attachments could not load: '+err.message,'error'));}
 if(canWrite){
 const types={pdf:'application/pdf',txt:'text/plain',csv:'text/csv',json:'application/json',docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg'};
 const upload=form([['file','Attach a research document or figure (up to 10 MiB)','file',true]],'Upload attachment',async({file},f)=>{
 const ext=file.name.split('.').pop().toLowerCase();if(!Object.hasOwn(types,ext)||file.size>10485760||!file.size)throw Error('Choose a nonempty PDF, DOCX, TXT, CSV, JSON, JPG or PNG up to 10 MiB.');
 const name=file.name.replace(/[^a-zA-Z0-9_.-]/g,'_').slice(-100),key=prefix+'/'+crypto.randomUUID()+'-'+name;
 const {error}=await storage.upload(key,file,{upsert:false,contentType:types[ext]});if(error)throw Error(error.message);f.reset();await list();
 });upload.querySelector('input').accept=Object.keys(types).map(k=>'.'+k).join(',');details.append(upload);}
 return details;
}
export function comparisonPanel(client,spaceId,base,datasets) {
 const options=datasets.filter(d=>d.id!==base.id);
 if(!options.length)return p('Import a second dataset to compare shared numeric fields.','muted');
 const result=el('div');
 return panel('Compare datasets',form([['other','Comparison dataset','select',true,options.map(d=>[d.id,d.name])]],'Compare recorded summaries',async f=>{
 const {data:other,error}=await client.from('datasets').select('name,records').eq('workspace_id',spaceId).eq('id',f.other).single();if(error)throw Error(error.message);
 const shared=columns(base.records).filter(k=>columns(other.records).includes(k)),rows=[];
 for(const key of shared){
 const a=describe(base.records.map(r=>r[key])),b=describe(other.records.map(r=>r[key]));
 if(!a.count||!b.count)continue;
 rows.push([key,a.count,b.count,a.mean.toPrecision(5),b.mean.toPrecision(5),(b.mean-a.mean).toPrecision(5)]);
 }
 result.replaceChildren(rows.length?table(['Field','N � '+base.name,'N � '+other.name,'Mean � '+base.name,'Mean � '+other.name,'Mean difference (second - first)'],rows):p('These datasets have no shared numeric fields.'));
 }),result);
}
