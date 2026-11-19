import {columns, toCsv, numeric} from './data.mjs';
export function el(tag,props={},...children) {
  const n=document.createElement(tag);
  for(const [k,v] of Object.entries(props)){
    if(v===undefined || v===null) continue;
    if(k==='class') n.className=v;
    else if(k.startsWith('on')) n.addEventListener(k.slice(2),v);
    else if(typeof v === 'boolean') n.toggleAttribute(k,v);
    else n.setAttribute(k,String(v));
  }
  n.append(...children.filter(x=>x!==undefined && x!==null));
  return n;
}
export const panel=(title,...children)=>el('section',{class:'panel'},el('h2',{},title),...children);
export const p=(t,cls='')=>el('p',{class:cls},t);
export const button=(label,callback,cls='')=>el('button',{type:'button',class:cls,onclick:callback},label);
export const option=(v,t)=>el('option',{value:v},t);
export function select(label,entries,value,change) {
 const input=el('select',{onchange:()=>change?.(input.value)},...entries.map(x=>option(...x)));
 if(entries.some(x=>x[0]===value)) input.value=value;
 return el('label',{},label,input);
}
export const accordion=(title,...children)=>el('details',{},el('summary',{},title),...children);
export function form(fields,label,submit) {
 const n=el('form',{class:'fields'});
 for(const [name,title,type='text',required=false,choices,initial] of fields) {
   let f;
   if(type==='select') f=el('select',{name,required},...choices.map(x=>Array.isArray(x)?option(...x):option(x,x)));
   else if(type==='textarea') f=el('textarea',{name,required,maxlength:12000});
   else f=el('input',{name,type,required,step:type==='number'?'any':undefined,autocomplete:type==='password'?(name==='new_password'?'new-password':'current-password'):type==='email'?'email':undefined,accept:type==='file'?'.csv,.json':undefined});
   if(initial!==undefined) f.value=initial;
   n.append(el('label',{},title,f));
 }
 const go=el('button',{type:'submit'},label);
 const message=p('','error');message.setAttribute('role','alert');n.append(go,message);
 n.addEventListener('submit',async e=>{e.preventDefault(); if(go.disabled) return; go.disabled=true;message.textContent='';
 try {await submit(Object.fromEntries(new FormData(n)),n);}catch(err){message.textContent=err?.message||String(err);}finally{go.disabled=false;}});
 return n;
}
export function table(headers,rows) {
 const body=el('tbody');
 for(const row of rows) body.append(el('tr',{},...row.map(x=>el('td',{},x instanceof Node?x:String(x??'-')))));
 return el('div',{class:'scroll'},el('table',{},el('thead',{},el('tr',{},...headers.map(h=>el('th',{scope:'col'},h)))),body));
}
export function dataGrid(rows) {
 if(!rows.length) return p('No records in this selection.','empty');
 const keys=columns(rows), target=el('div'), controls=el('div',{class:'selectors no-print'});
 let query='',key=keys[0],direction=1,page=0;
 const search=el('input',{type:'search',placeholder:'Search all columns',oninput:()=>{query=search.value.toLowerCase();page=0;draw();}});
 controls.append(el('label',{},'Filter records',search),select('Sort by',keys.map(k=>[k,k]),key,v=>{key=v;page=0;draw();}),button('Reverse order',()=>{direction*=-1;page=0;draw();}));
 function draw(){
  const filtered=rows.filter(r=>Object.values(r).some(v=>String(v??'').toLowerCase().includes(query))).sort((a,b)=>direction*String(a[key]??'').localeCompare(String(b[key]??''),undefined,{numeric:true}));
  const portion=filtered.slice(page*50,page*50+50);
  const prev=button('Previous',()=>{page--;draw();}), next=button('Next',()=>{page++;draw();});
  prev.disabled=page===0;next.disabled=(page+1)*50>=filtered.length;
  target.replaceChildren(p(filtered.length+' matching records','muted'),table(keys,portion.map(r=>keys.map(k=>Object.hasOwn(r,k)?r[k]:null))),el('div',{class:'actions no-print'},prev,next));
 }
 draw();return el('div',{},controls,target);
}
export function download(name,value,type){
 const url=URL.createObjectURL(new Blob([value],{type}));const link=el('a',{href:url,download:name});document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),2000);
}
export const exportsFor=(name,rows)=>el('div',{class:'actions no-print'},button('Export CSV',()=>download(name+'.csv',toCsv(rows),'text/csv;charset=utf-8')),button('Export JSON',()=>download(name+'.json',JSON.stringify(rows,null,2),'application/json')));
export function chart(points,kind,title,xLabel,yLabel,fixed=false) {
 const valid=points.filter(([x,y])=>numeric(x)!==null&&numeric(y)!==null);
 if(!valid.length) return p('No numeric data for this selection.','empty');
 const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
 const width=660,height=244,left=65,right=16,top=12,bottom=37;
 svg.setAttribute('viewBox','0 0 '+width+' '+height); svg.setAttribute('class','chart');svg.setAttribute('role','img');svg.setAttribute('aria-label',title+'; '+xLabel+' by '+yLabel+'; '+valid.length+' points');
 function shape(type,attrs,txt){const s=document.createElementNS(svg.namespaceURI,type);for(const [k,v] of Object.entries(attrs))s.setAttribute(k,String(v));if(txt!==undefined)s.textContent=txt;svg.append(s);return s;}
 let xs=valid.map(r=>Number(r[0])),ys=valid.map(r=>Number(r[1]));
 let xmin=fixed?0:Math.min(...xs),xmax=fixed?1:Math.max(...xs);
 let ymin=fixed?0:Math.min(0,...ys),ymax=fixed?1:Math.max(0,...ys);
 if(xmin===xmax){xmin-=.5;xmax+=.5;}if(ymin===ymax)ymax=ymin+1;
 const inset=kind==='bar'?(width-left-right)/(2*valid.length):0;
 const X=x=>left+inset+(x-xmin)/(xmax-xmin)*(width-left-right-2*inset);
 const Y=y=>top+(ymax-y)/(ymax-ymin)*(height-top-bottom);
 for(let i=0;i<=4;i++){const v=ymin+(ymax-ymin)*i/4;shape('line',{x1:left,x2:width-right,y1:Y(v),y2:Y(v),stroke:'#e4deeb'});shape('text',{x:left-8,y:Y(v)+4,'text-anchor':'end','font-size':12,fill:'#655776'},Number(v.toPrecision(3)).toString());}
 for(const x of [xmin,xmax])shape('text',{x:X(x),y:height-9,'text-anchor':'middle','font-size':12,fill:'#655776'},Number(x.toPrecision(3)).toString());
 if(kind==='line')shape('polyline',{points:valid.map(([x,y])=>X(x)+','+Y(y)).join(' '),stroke:'#6635ba','stroke-width':2.5,fill:'none'});
 if(kind==='bar') valid.forEach(([x,y])=>shape('rect',{x:X(x)-inset*.75,y:Math.min(Y(y),Y(0)),width:Math.max(.5,inset*1.5),height:Math.abs(Y(y)-Y(0)),fill:'#7449bc'}));
 else if(kind==='scatter'||valid.length<150)valid.forEach(([x,y])=>shape('circle',{cx:X(x),cy:Y(y),r:3.5,fill:'#7341ad'}));
 return el('figure',{},svg,el('figcaption',{class:'chart-label'},title+' � '+xLabel+' / '+yLabel));
}
