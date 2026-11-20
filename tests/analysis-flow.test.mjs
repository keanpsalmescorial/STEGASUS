import test from 'node:test';
import assert from 'node:assert/strict';
import {mountAnalysis} from '../dist/studio/analysis.js';

class Element{
  constructor(tag){this.tag=tag;this.children=[];this.attrs={};this.listeners={};this.hidden=false;this.value='';this._text='';}
  set textContent(value){this._text=String(value);this.children=[];}
  get textContent(){return this._text+this.children.map(c=>typeof c==='string'?c:c.textContent).join(' ');}
  setAttribute(k,v){this.attrs[k]=v;}
  addEventListener(k,fn){this.listeners[k]=fn;}
  append(...children){for(const c of children){if(typeof c!=='string')c.parent=this;this.children.push(c);}}
  replaceChildren(...children){this.children=[];this._text='';this.append(...children);}
  replaceWith(node){const i=this.parent.children.indexOf(this);this.parent.children[i]=node;node.parent=this.parent;}
  querySelector(selector){return all(this).find(n=>selector==='[data-job-progress]'&&n.attrs['data-job-progress']);}
  get isConnected(){return true;}
  focus(){}
}
function all(root){return [root,...root.children.filter(c=>typeof c!=='string').flatMap(all)];}
function setup(jobs){
  globalThis.document={createElement:tag=>new Element(tag),createTextNode:text=>String(text),head:new Element('head'),querySelector:()=>null,hidden:false};
  const calls=[];
  const client={functions:{invoke:async(name,{body})=>{calls.push(body);return {data:body.action==='availability'?{configured:true,online:true,limit:2**31,retryableJobIds:jobs.filter(j=>j.retryable).map(j=>j.id)}:{assets:[]}};}},from:()=>{
    const query={select(){return query;},eq(){return query;},order(){return query;},limit:async()=>({data:jobs,error:null})};return query;
  }};
  return {container:new Element('div'),client,calls};
}
test('new analysis starts with a simple upload and collapsed history',async()=>{
  const {container,client}=setup([]);const dispose=await mountAnalysis(container,{client,workspaceId:'w',projectId:'p',role:'researcher'});
  try{
    const nodes=all(container);assert.ok(nodes.some(n=>n.tag==='button'&&n.textContent==='Analyze slide'));
    assert.equal(nodes.find(n=>n.attrs.class==='analysis-history').open,undefined);
    assert.equal(nodes.find(n=>n.attrs.placeholder==='Defaults to the slide filename').attrs.required,undefined);
  }finally{dispose();}
});
test('saved-slide retry is explicit and never starts another upload',async()=>{
  const jobs=[{id:'saved',case_id:'case',filename:'test_004.tif',status:'failed',retryable:true,created_at:new Date().toISOString(),updated_at:new Date().toISOString()}];
  const {container,client,calls}=setup(jobs);const dispose=await mountAnalysis(container,{client,workspaceId:'w',projectId:'p',role:'researcher'});
  try{
    assert.equal(calls.some(b=>b.action==='retry'),false);
    await all(container).find(n=>n.tag==='button'&&n.textContent==='Retry saved slide: test_004.tif').listeners.click();
    assert.equal(calls.filter(b=>b.action==='retry').length,1);
    assert.equal(calls.find(b=>b.action==='retry').jobId,'saved');
    assert.equal(calls.some(b=>b.action==='begin'),false);
  }finally{dispose();}
});
test('queued analysis is followed automatically and completion reveals report without another click',async()=>{
  const jobs=[{id:'job',case_id:'case',filename:'slide.tif',status:'queued',created_at:new Date().toISOString(),updated_at:new Date().toISOString()}];
  const {container,client}=setup(jobs);const dispose=await mountAnalysis(container,{client,workspaceId:'w',projectId:'p',role:'researcher'});
  try{
    assert.equal(all(container).find(n=>n.tag==='form').hidden,true);
    jobs[0]={...jobs[0],status:'completed',result:{classification:'Below threshold',score:.33,threshold:.628536,patchCount:123,expertScores:{},modelVersion:'frozen'}};
    await all(container).find(n=>n.tag==='button'&&n.textContent==='Refresh jobs').listeners.click();
    // The event handler returns refresh's promise, so result rendering is complete.
    assert.match(container.textContent,/Your analysis report/);
    assert.ok(all(container).some(n=>n.tag==='button'&&n.textContent==='Download report'));
    await all(container).find(n=>n.tag==='button'&&n.textContent==='Analyze another slide').listeners.click();
    assert.equal(all(container).find(n=>n.tag==='form').hidden,false);
  }finally{dispose();}
});
