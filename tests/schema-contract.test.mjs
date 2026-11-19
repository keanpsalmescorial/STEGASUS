import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const sql = readFileSync(new URL('../supabase/migrations/20261119000100_workspace.sql',import.meta.url),'utf8');
const tables = [...sql.matchAll(/create table public\.(\w+)\(/g)].map(match=>match[1]);
test('every workspace relation declares RLS and resets default client grants',()=>{
  assert.equal(tables.length,13);
  for(const table of tables){
    assert.ok(sql.includes(`alter table public.${table} enable row level security;`),table);
    assert.ok(sql.includes(`revoke all on public.${table} from public,anon,authenticated;`),table);
  }
});
test('research record mutations never grant parent or attribution changes',()=>{
  const updates = [...sql.matchAll(/grant update\(([^)]+)\) on public\.\w+ to authenticated/g)];
  assert.ok(updates.length>=9);
  for(const [,fields] of updates){
    assert.doesNotMatch(fields,/\bid\b|workspace_id|project_id|experiment_id|run_id|variable_id|created_by|created_at/);
  }
});
test('definer functions lock name resolution and remove default public execution',()=>{
  for(const declaration of sql.matchAll(/create (?:or replace )?function public\.(\w+)\([^$]+?security definer[^$]+?as \$\$/gi)){
    const [full,name] = declaration;
    assert.match(full,/set search_path=''/);
    assert.ok(sql.includes(`revoke all on function public.${name}(`), name);
  }
});
test('measurement parent links carry workspace and experiment IDs',()=>{
  for(const parent of ['experiment_runs','experiment_variables','samples']){
    assert.ok(sql.includes(`references public.${parent}(workspace_id,experiment_id,id)`),parent);
  }
});
