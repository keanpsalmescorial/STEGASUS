"use strict";
const $ = (id) => document.getElementById(id);
function node(tag, content, className) {
  const el = document.createElement(tag);
  if (content !== undefined) el.textContent = content;
  if (className) el.className = className;
  return el;
}
const guideItems = [
  ["abstract","Abstract","Read the study in brief.","M5 3h10l4 4v14H5z M15 3v5h4 M8 12h8m-8 4h6"],
  ["background","Background","Understand the pathology problem.","M3 5c3-1 6 0 9 2 3-2 6-3 9-2v14c-3-1-6 0-9 2-3-2-6-3-9-2z M12 7v14"],
  ["methodology","Methodology","Follow the four-expert workflow.","M4 4h5v5H4z M15 15h5v5h-5z M9 6h8v9 M6 9v9h9"],
  ["results","Results","Explore the recorded comparisons.","M4 3v17h17 M8 16v-5m5 5V7m5 9v-8"],
  ["findings","Additional findings","Examine deposit size and spatial context.","M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14 M15 15l6 6"],
  ["conclusion","Conclusion","Review findings and next steps.","M4 5h16v14H4z M7 12l3 3 7-7"]
];
for (const [id, title, description, path] of guideItems) {
  const link = node("a",undefined,"guide");
  link.href = "#" + id;
  const icon = document.createElementNS("http://www.w3.org/2000/svg","svg");
  icon.setAttribute("viewBox","0 0 24 24"); icon.setAttribute("aria-hidden","true");
  const line=document.createElementNS(icon.namespaceURI,"path"); line.setAttribute("d",path); icon.append(line);
  link.append(icon,node("b",title),node("span",description)); $("guide").append(link);
}
const steps = [
  ["Dataset preparation","Verify PatchCamelyon metadata and group patches by source slide. The reported partitions contained 216 training groups, 54 development groups, and 128 labeled test groups."],
  ["Image expert development","Fine-tune EfficientNetB0, MobileViT-XXS, and ResNet50 on tissue patches. Aggregate patch outputs to aligned source-slide scores."],
  ["Spatial Graph Expert","Represent patches using frozen EfficientNetB0 features and connect neighboring patch coordinates. Apply graph processing and attention pooling to produce a group score."],
  ["Calibrated logistic stacking","Combine four aligned expert scores by logistic stacking. Use the development partition for calibration and selection of the 0.628536 decision threshold."],
  ["Model evaluation","Compare experts and the ensemble, test graph connections and expert removal, and examine paired statistical results alongside supplementary MIL benchmarks."],
  ["Whole-slide processing and application","Run frozen inference on selected CAMELYON16 slides. Retain research scores, processing records, and ResNet50 patch-score heatmaps."]
];
steps.forEach(([title, description],i) => {
  const item=node("article",undefined,"step");item.append(node("span",String(i+1)),node("h3",title),node("p",description)); $("steps").append(item);
});
const primary=[["Accuracy",0.9141],["Precision",1],["Sensitivity",0.7708],["Specificity",1],["F1-score",0.8706],["AUROC",0.9945],["Average precision",0.9908],["Brier score",0.0565],["Log loss",0.2072]];
const whole=[["Accuracy",.8],["Sensitivity",.6],["Specificity",1],["AUROC",.72],["Average precision",.819]];
function plot(container,rows,scale=1) {
  const chart=node("div",undefined,"chart");
  for(const [label,value,printed] of rows){
    const line=node("div",undefined,"bar-row"),track=node("div",undefined,"track"),fill=node("div",undefined,"fill");
    track.setAttribute("aria-hidden","true");fill.style.width=(Math.min(1,Math.max(0,value/scale))*100)+"%";
    track.append(fill);line.append(node("span",label),track,node("span",printed??value.toFixed(4),"value"));chart.append(line);
  }
  container.append(chart);
}
function drawMatrix(id,counts){
  const table=node("table",undefined,"matrix"),labels=["Actual / predicted","Negative","Positive"];
  table.setAttribute("aria-label","Confusion matrix");let row=table.insertRow();
  labels.forEach(label=>{const th=node("th",label);th.scope="col";row.append(th)});
  for(let i=0;i<2;i++){row=table.insertRow();const th=node("th",labels[i+1]);th.scope="row";row.append(th);
    for(let j=0;j<2;j++){const cell=row.insertCell();cell.textContent=String(counts[i*2+j]);if(i===j)cell.className="correct";}
  }
  $(id).append(node("h4","Confusion matrix"),table);
}
for(const [prefix,rows,counts] of [["primary",primary,[80,0,11,37]],["slide",whole,[10,0,4,6]]]){
  $(prefix+"-chart").append(node("h4","Recorded metrics"));plot($(prefix+"-chart"),rows);drawMatrix(prefix+"-matrix",counts);
}
const tabs=[...document.querySelectorAll('[role="tab"]')];
function activate(tab,focus=false){
  tabs.forEach(t=>{const selected=t===tab;t.setAttribute("aria-selected",String(selected));t.tabIndex=selected?0:-1;$(t.getAttribute("aria-controls")).hidden=!selected});
  if(focus)tab.focus();
}
tabs.forEach((tab,i)=>{
  tab.addEventListener("click",()=>activate(tab));
  tab.addEventListener("keydown",e=>{
    const next={ArrowRight:(i+1)%tabs.length,ArrowLeft:(i+tabs.length-1)%tabs.length,Home:0,End:tabs.length-1}[e.key];
    if(next!==undefined){e.preventDefault();activate(tabs[next],true)}
  });
});
const menu=document.querySelector(".menu"),nav=$("links");
function closeNav(){menu.setAttribute("aria-expanded","false");nav.classList.remove("open");document.querySelector(".more").open=false}
menu.addEventListener("click",()=>{const open=nav.classList.toggle("open");menu.setAttribute("aria-expanded",String(open))});
nav.addEventListener("click",e=>{if(e.target.closest("a"))closeNav()});
document.addEventListener("keydown",e=>{if(e.key==="Escape"){closeNav();$("matches").replaceChildren()}});
document.addEventListener("click",e=>{if(!e.target.closest("header"))closeNav()});
const sectionIds=["home","overview","abstract","background","methodology","results","findings","limitations","conclusion","team"];
const navLinks=[...nav.querySelectorAll('a[href^="#"]')];
function activeNav(){
  const id=sectionIds.filter(key=>$(key).getBoundingClientRect().top<window.innerHeight*.32).at(-1)||"home";
  navLinks.forEach(link=>{if(link.hash==="#"+(id==="abstract"?"overview":id))link.setAttribute("aria-current","location");else link.removeAttribute("aria-current")});
}
let ticking=false;
addEventListener("scroll",()=>{if(!ticking){ticking=true;requestAnimationFrame(()=>{activeNav();ticking=false})}},{passive:true});
const indexed=["abstract","background","methodology","primary","experts","slides","benchmarks","findings","limitations","conclusion","team"];
let manuscript;
function search(term){
  const q=term.trim().toLocaleLowerCase(),box=$("matches");box.replaceChildren();if(!q)return;
  const terms=q.split(/\s+/);
  const candidates=indexed.map(id=>{const section=$(id);return {label:section.querySelector("h2,h3")?.textContent??"Research team",text:section.textContent,target:section}});
  for(const d of $("archive").querySelectorAll("details"))candidates.push({label:d.querySelector("summary").textContent,text:d.textContent,target:d});
  const hits=candidates.filter(r=>terms.every(t=>r.text.toLowerCase().includes(t))).slice(0,10);
  if(!hits.length){box.textContent="No matching research sections or records.";return}
  hits.forEach(({label,target})=>{
    const link=node("a",label);link.href="#"+target.id;
    link.addEventListener("click",()=>{const tab=tabs.find(t=>t.getAttribute("aria-controls")===target.id);if(tab)activate(tab);if(target.tagName==="DETAILS")target.open=true;box.replaceChildren();requestAnimationFrame(()=>target.scrollIntoView())});box.append(link);
  });
}
$("search").addEventListener("submit",e=>{e.preventDefault();search($("query").value)});
document.querySelectorAll(".chips button").forEach(b=>b.addEventListener("click",()=>{$("query").value=b.textContent;search(b.textContent)}));
function tableDetail(t){
  const detail=node("details",undefined,"table-card");detail.append(node("summary",(t.number?"Table "+t.number+" · ":"")+t.title));
  const wrap=node("div",undefined,"scroll-table"),table=node("table",undefined,"report-table"),head=table.createTHead().insertRow();
  t.columns.forEach(v=>{const th=node("th",v);th.scope="col";head.append(th)});
  const tbody=table.createTBody();t.rows.forEach(row=>{const tr=tbody.insertRow();row.forEach(v=>tr.append(node("td",v)))});
  wrap.append(table);detail.append(wrap);if(t.note)detail.append(node("p",t.note));return detail;
}
function numeric(v){
  const text=String(v??"").trim().replaceAll(",","").replace("−","-");
  const match=text.match(/^(-?(?:\d+(?:\.\d*)?|\.\d+))\s*(%?)(?:\s*(?:±|\(|\[).*|\s*)$/);
  return match?{value:Number(match[1]),printed:text}:null;
}
function interactiveTableChart(slot,tables){
  const options=[];
  tables.forEach(t=>t.columns.forEach((col,i)=>{
    if(i===0||/difference|seed|threshold|raw p|holm|confusion/i.test(col))return;
    const seedCol=t.columns.indexOf("Seed");
    const values=t.rows.map(r=>({label:r[0]+(seedCol>=0?" · seed "+r[seedCol]:""),num:numeric(r[i])})).filter(x=>x.num&&x.num.value>=0);
    if(values.length>=2&&new Set(values.map(v=>v.label)).size>1)options.push({label:(t.number?"Table "+t.number+" · ":"")+col,values});
  }));
  if(!options.length)return;
  const chart=node("div"),label=node("label","Compare a reported measure ", "plot-label"),select=node("select");
  options.forEach((o,i)=>{const opt=node("option",o.label);opt.value=String(i);select.append(opt)});
  label.append(select);slot.append(label,chart);
  const update=()=>{chart.replaceChildren();const values=options[Number(select.value)].values,scale=Math.max(1,...values.map(v=>v.num.value));plot(chart,values.map(v=>[v.label,v.num.value,v.num.printed]),scale)};
  select.addEventListener("change",update);update();
}
function sourceGroup(id,tables,withChart=true){
  if(!tables.length)return;const slot=$(id);if(withChart)interactiveTableChart(slot,tables);tables.forEach(t=>slot.append(tableDetail(t)));
}
function renderData(data,comparison){
  manuscript=data;
  renderEvidence(comparison);
  $("abstract-text").textContent=Array.isArray(data.abstract)?data.abstract.join(" "):data.abstract;
  const tables=data.tables??[],figures=data.figures??[];
  sourceGroup("expert-tables",[comparison,...tables.filter(t=>t.number>=15&&t.number<=19)],false);
  sourceGroup("benchmark-tables",tables.filter(t=>t.number>=25&&t.number<=32));
  sourceGroup("ablation-tables",tables.filter(t=>(t.number>=11&&t.number<=13)||(t.number>=20&&t.number<=23)));
  const addFigure=(id,num)=>{
    const f=figures.find(x=>x.number===num);
    if(!f?.src)return;
    const d=node("figure",undefined,"evidence-figure");
    const img=node("img");img.alt=f.caption;img.loading="lazy";img.src=f.src;
    const link=node("a");link.href=f.src;link.target="_blank";link.rel="noopener";link.setAttribute("aria-label","Open supporting research figure at full size");link.append(img);
    d.append(link,node("figcaption",f.caption));$(id).append(d);
  };
  for(const [id,nums] of Object.entries({primary:[13],experts:[8],slides:[15],benchmarks:[17,19],methodology:[1],findings:[21,22]})){
    nums.forEach(num=>addFigure(id,num));
  }
  const archive=$("archive");archive.replaceChildren();const label=node("label","Filter records "),input=node("input");
  input.type="search";input.placeholder="Title, model, or table number";label.append(input);archive.append(label);
  const cards=[];
  for(const t of tables){const detail=tableDetail(t);detail.id="table-"+t.number;archive.append(detail);cards.push(detail)}
  for(const f of figures){if(!f.caption)continue;const detail=node("details",undefined,"figure-card");detail.id="figure-"+f.number;detail.append(node("summary",/^figure\s+\d/i.test(f.caption)?f.caption:"Figure "+f.number+" · "+f.caption));
    if(f.src){const img=node("img");img.alt=f.caption;img.loading="lazy";img.src=f.src;detail.append(img)}else detail.append(node("p","Caption available in the manuscript. Image unavailable in this edition."));archive.append(detail);cards.push(detail);
  }
  const report=node("p");report.setAttribute("role","status");archive.append(report);
  input.addEventListener("input",()=>{const q=input.value.trim().toLowerCase();let count=0;cards.forEach(d=>{d.hidden=!d.textContent.toLowerCase().includes(q);if(!d.hidden)count++});report.textContent=count+" matching records"});
  for(const r of data.references??[])$("references").append(node("li",r));
}
Promise.all(["manuscript","internal-comparison"].map(name=>fetch("data/"+name+".json").then(r=>{if(!r.ok)throw Error("Unavailable");return r.json()}))).then(([data,comparison])=>renderData(data,comparison)).catch(()=>{
  $("archive").textContent="The manuscript archive could not be loaded. Reload the page to retry.";
  $("abstract-text").textContent="The manuscript abstract could not be loaded."; $("references").append(node("li","Reference list unavailable."));
});
if(!matchMedia("(prefers-reduced-motion: reduce)").matches){
  document.querySelectorAll(".metrics strong").forEach(el=>{
    const text=el.firstChild,end=parseFloat(text.data),places=text.data.split(".")[1]?.length??0;
    el.setAttribute("aria-label",el.textContent);const start=performance.now();
    function frame(now){const t=Math.min(1,(now-start)/620);text.data=(end*(1-Math.pow(1-t,3))).toFixed(places);if(t<1)requestAnimationFrame(frame)}
    requestAnimationFrame(frame);
  });
}


function insight(label,score,title,description){
  const card=node("aside",undefined,"evidence-insight");
  card.append(node("p",label,"kicker"),node("strong",score),node("h4",title),node("p",description));return card;
}
function renderEvidence(comparison){
  $("primary").insertBefore(insight("Main finding","37 / 48","Positive internal groups detected","At the selected threshold, 37 positive groups were detected and 11 were missed. All 80 negative groups were classified as negative. These counts explain the reported sensitivity and specificity."),$("primary-chart").parentElement);
  $("slides").insertBefore(insight("Whole-slide finding","6 / 10","Positive whole slides detected","The frozen pipeline correctly classified all ten negative slides and six positive slides in the selected 20-slide cohort. Whole-slide results are reported separately from the internal source-slide groups."),$("slide-chart").parentElement);
  const slot=$("expert-tables"),layout=node("div",undefined,"comparison-story"),chart=node("div"),label=node("label","Compare experts by ","plot-label"),select=node("select"),summary=node("p",undefined,"chart-caption");
  select.setAttribute("aria-label","Expert comparison metric");
  for(const metric of ["Brier score","AUROC","Sensitivity","Accuracy","Log loss"]){const option=node("option",metric);option.value=metric;select.append(option)}
  label.append(select);chart.append(label);const bars=node("div");chart.append(bars,summary);
  const update=()=>{const metric=select.value,index=comparison.columns.indexOf(metric);bars.replaceChildren();const values=comparison.rows.map(row=>[row[0],Number(row[index]),row[index]]);plot(bars,values,Math.max(1,...values.map(row=>row[1])));summary.textContent=(/Brier|Log loss/.test(metric)?"Lower values indicate smaller probability error.":"Higher values indicate stronger performance on this measure.")+" Same 128 internal source-slide groups; bars start at zero."};
  select.addEventListener("change",update);update();
  layout.append(chart,insight("Probability quality","0.0565","Lowest recorded Brier score","The ensemble had lower probability error than the individual experts and simple averaging in this comparison. The Spatial Graph Expert had stronger sensitivity and AUROC; each measure answers a different question."));slot.before(layout);
  $("benchmarks").insertBefore(insight("Reading the comparison","3 seeds","Compare performance and stability","CLAM, DTFD-MIL, and CAMIL were adapted to shared features. Read the primary comparison alongside variation across training seeds. Cached-feature inference timings exclude slide reading and encoder computation."),$("benchmark-tables"));
}
if("IntersectionObserver" in window&&!matchMedia("(prefers-reduced-motion: reduce)").matches){
  const observer=new IntersectionObserver(entries=>{for(const entry of entries)if(entry.isIntersecting){entry.target.classList.add("is-visible");observer.unobserve(entry.target)}},{threshold:.08});
  document.querySelectorAll("main>section:not(.hero),.metrics-wrap").forEach(section=>{section.classList.add("reveal");observer.observe(section)});
}
