export function readCsv(text) {
  text = text.replace(/^\uFEFF/, '');
  const rows = [];
  let row = [], field = '', quoted = false, closed = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (char === '"') { quoted = false; closed = true; }
      else field += char;
    } else if (char === ',') { row.push(field); field = ''; closed = false; }
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = ''; closed = false;
    } else if (char === '"' && field === '' && !closed) quoted = true;
    else if (closed || char === '"') throw Error('CSV contains an unexpected quote or text after a closing quote.');
    else field += char;
  }
  if (quoted) throw Error('CSV contains an unclosed quoted field.');
  if (field || row.length || closed) { row.push(field); rows.push(row); }
  const headers = (rows.shift() || []).map(h => h.trim());
  if (!headers.length || headers.some(h => !h) || new Set(headers).size !== headers.length) throw Error('Use a unique, nonempty name for every column.');
  return validateRows(rows.filter(r => r.length > 1 || r[0] !== '').map((cells,i) => {
    if (cells.length !== headers.length) throw Error('Unexpected column count on data row '+(i+1)+'.');
    return Object.fromEntries(headers.map((h,j) => [h,cells[j]]));
  }));
}
export function validateRows(rows) {
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > 5000) throw Error('Supply between 1 and 5,000 data rows.');
  for (const row of rows) {
    if (row === null || Array.isArray(row) || typeof row !== 'object') throw Error('Each data row must be an object with named columns.');
    if (!Object.keys(row).length || Object.keys(row).some(k => !k.trim() || ['constructor','__proto__','prototype'].includes(k))) throw Error('Invalid column name.');
    if (Object.values(row).some(v => v !== null && !['number','string','boolean'].includes(typeof v))) throw Error('Cells must contain text, a number, a Boolean, or null.');
  }
  if (columns(rows).length > 100) throw Error('Use at most 100 columns.');
  return rows;
}
export const columns = rows => [...new Set(rows.flatMap(Object.keys))];
export function toCsv(rows) {
  const headers = columns(rows);
  function escape(v) {
    let s = String(v ?? '');
    if (typeof v === 'string' && /^[\s]*[=+@-]/u.test(s)) s = "'"+s;
    return '"'+s.replaceAll('"','""')+'"';
  }
  return [headers,...rows.map(r=>headers.map(k=>Object.hasOwn(r,k)?r[k]:''))].map(r=>r.map(escape).join(',')).join('\r\n');
}
export function numeric(v) {
  if (typeof v !== 'number' && (typeof v !== 'string' || !v.trim())) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
export function describe(values) {
  const nums = values.map(numeric).filter(v=>v!==null);
  if (!nums.length) return {count:0};
  const mean = nums.reduce((a,b)=>a+b,0)/nums.length;
  return {count:nums.length, mean, sd:nums.length>1?Math.sqrt(nums.reduce((s,v)=>s+(v-mean)**2,0)/(nums.length-1)):null, min:Math.min(...nums), max:Math.max(...nums)};
}
export function classify(rows, label, score, threshold) {
  if (!label || !score || label===score || numeric(threshold)===null) throw Error('Choose distinct label and score columns and a finite threshold.');
  let tn=0,fn=0,tp=0,fp=0;
  const pairs = rows.map((r,i)=>{
    const y=numeric(r[label]), p=numeric(r[score]);
    if ((y!==0 && y!==1) || p===null) throw Error('Invalid label or score on row '+(i+1)+'. Use 0/1 labels and finite scores for every row.');
    if (p>=threshold) { if (y) tp++; else fp++; } else if (y) fn++; else tn++;
    return [p,y];
  }).sort((a,b)=>b[0]-a[0]);
  const pos=tp+fn, neg=tn+fp, roc=[], pr=[];
  if (pos && neg) roc.push([0,0]);
  if (pos) pr.push([0,1]);
  let hits=0, misses=0, area=0, ap=0;
  for(let i=0;i<pairs.length;) {
    const cut = pairs[i][0], prevHits=hits, prevMiss=misses;
    while(i<pairs.length && pairs[i][0]===cut) { if(pairs[i++][1]) hits++; else misses++; }
    if(pos && neg) { roc.push([misses/neg,hits/pos]); area+=(misses-prevMiss)/neg*(hits+prevHits)/(2*pos); }
    if(pos) { const precision=hits/(hits+misses); pr.push([hits/pos,precision]); ap+=(hits-prevHits)/pos*precision; }
  }
  return {tn,fn,tp,fp,roc,pr,auroc:pos&&neg?area:null,ap:pos?ap:null};
}
