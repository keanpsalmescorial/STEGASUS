-- Integration test on a disposable, migrated Supabase database:
-- psql -X -v ON_ERROR_STOP=1 "$TEST_DATABASE_URL" -f tests/workspace-rls.sql
-- Run as the local postgres migration role. All fixtures are rolled back.
begin;
select gen_random_uuid() owner_id, gen_random_uuid() viewer_id,
       gen_random_uuid() outsider_id \gset
insert into auth.users(id,email,email_confirmed_at)
select id,id::text||'@example.invalid',now()
from (values (:'owner_id'::uuid),(:'viewer_id'::uuid),(:'outsider_id'::uuid)) users(id);
set local role authenticated;
select set_config('request.jwt.claim.sub',:'owner_id',true);
select public.create_workspace('Research QA','general') as workspace \gset
insert into public.projects(workspace_id,name) values(:'workspace','Study') returning id as project \gset
insert into public.experiments(workspace_id,project_id,name) values(:'workspace',:'project','Trial') returning id as experiment \gset
insert into public.experiment_variables(workspace_id,experiment_id,name,kind) values(:'workspace',:'experiment','Duration','numeric') returning id as variable \gset
select public.record_run(:'workspace',:'experiment','Observation',1,now(),'{}','',jsonb_build_object(:'variable',2.5)) as run \gset
select set_config('test.workspace',:'workspace',true),set_config('test.experiment',:'experiment',true),
       set_config('test.variable',:'variable',true),set_config('test.run',:'run',true);
do $$
begin
 if (select count(*) from public.measurements where run_id=current_setting('test.run')::uuid and value='2.5'::jsonb)<>1 then raise exception 'Missing measurement'; end if;
 begin
  perform public.record_run(current_setting('test.workspace')::uuid,current_setting('test.experiment')::uuid,'Invalid',1,now(),'{}','',
    jsonb_build_object(current_setting('test.variable'),'invalid'));
  raise exception 'Invalid measurement accepted';
 exception when raise_exception then
  if sqlerrm<>'Value has wrong type' then raise; end if;
 end;
 if exists(select from public.experiment_runs where workspace_id=current_setting('test.workspace')::uuid and name='Invalid') then raise exception 'Partial run saved'; end if;
end $$;
select public.invite_member(:'workspace',:'viewer_id'||'@example.invalid','viewer') as token \gset
select set_config('request.jwt.claim.sub',:'viewer_id',true);
select public.accept_invitation(:'token');
select set_config('test.token',:'token',true);
do $$
begin
 if not exists(select from public.measurements where run_id=current_setting('test.run')::uuid) then raise exception 'Viewer cannot read'; end if;
 if not public.has_workspace_role(current_setting('test.workspace')::uuid,array['viewer']) then raise exception 'Unexpected viewer role'; end if;
 begin
  insert into public.datasets(workspace_id,name) values(current_setting('test.workspace')::uuid,'Viewer write');
  raise exception 'Viewer write accepted';
 exception when insufficient_privilege then null; end;
 begin
  perform public.accept_invitation(current_setting('test.token'));
  raise exception 'Invitation accepted twice';
 exception when insufficient_privilege then null; end;
end $$;
select set_config('request.jwt.claim.sub',:'outsider_id',true);
select public.create_workspace('Independent team','personal') as other_workspace \gset
do $$
begin
 if exists(select from public.projects where workspace_id=current_setting('test.workspace')::uuid)
    or exists(select from public.measurements where run_id=current_setting('test.run')::uuid)
    or exists(select from public.activity_logs where workspace_id=current_setting('test.workspace')::uuid)
 then raise exception 'Cross-workspace read'; end if;
end $$;
reset role;
rollback;
