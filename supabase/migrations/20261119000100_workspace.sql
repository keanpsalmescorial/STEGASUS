-- PostgreSQL 15+ / Supabase Auth. Public clients receive only the grants below.
begin;
create table public.profiles(
  id uuid primary key references auth.users on delete cascade,
  display_name text not null default '' check(length(display_name)<=160)
);
create table public.workspaces(
  id uuid primary key default gen_random_uuid(), name text not null check(length(trim(name)) between 1 and 200),
  template text not null check(template in ('pathology','ml','general','personal')),
  created_by uuid references auth.users on delete set null, created_at timestamptz not null default now()
);
create table public.workspace_members(
  workspace_id uuid not null references public.workspaces on delete cascade, user_id uuid not null references auth.users on delete cascade,
  role text not null check(role in ('owner','administrator','researcher','reviewer','viewer')),
  created_at timestamptz not null default now(), primary key(workspace_id,user_id)
);
create unique index one_workspace_owner on public.workspace_members(workspace_id) where role='owner';
create index member_workspace_lookup on public.workspace_members(user_id,workspace_id);
create table public.workspace_invitations(
  id uuid primary key default gen_random_uuid(), workspace_id uuid not null references public.workspaces on delete cascade,
  email text not null, role text not null check(role in ('administrator','researcher','reviewer','viewer')),
  token_hash bytea not null unique, created_by uuid references auth.users on delete set null,
  expires_at timestamptz not null default now()+interval '7 days', unique(workspace_id,email)
);
create table public.projects(
  id uuid primary key default gen_random_uuid(), workspace_id uuid not null references public.workspaces on delete cascade,
  created_by uuid default auth.uid() references auth.users on delete set null, created_at timestamptz not null default now(),
  name text not null check (length(trim(name)) between 1 and 200),
  objectives text not null default '', unique(workspace_id,id)
);
create index projects_workspace_time on public.projects(workspace_id,created_at desc);
create table public.experiments(
  id uuid primary key default gen_random_uuid(), workspace_id uuid not null references public.workspaces on delete cascade,
  created_by uuid default auth.uid() references auth.users on delete set null, created_at timestamptz not null default now(),
  project_id uuid not null, name text not null check(length(trim(name)) between 1 and 200),
  description text not null default '', objectives text not null default '', research_question text not null default '',
  procedure_text text not null default '', conditions text not null default '', notes text not null default '',
  foreign key(workspace_id,project_id) references public.projects(workspace_id,id) on delete cascade,
  unique(workspace_id,id)
);
create index experiments_workspace_time on public.experiments(workspace_id,created_at desc);
create table public.experiment_variables(
  id uuid primary key default gen_random_uuid(), workspace_id uuid not null references public.workspaces on delete cascade,
  created_by uuid default auth.uid() references auth.users on delete set null, created_at timestamptz not null default now(),
  experiment_id uuid not null, name text not null check(length(trim(name)) between 1 and 200),
  kind text not null check(kind in ('numeric','categorical','text','datetime')), unit text not null default '',
  variable_role text not null default 'other' check(variable_role in ('independent','dependent','controlled','other')),
  foreign key(workspace_id,experiment_id) references public.experiments(workspace_id,id) on delete cascade,
  unique(workspace_id,experiment_id,id), unique(experiment_id,name)
);
create index experiment_variables_workspace_time on public.experiment_variables(workspace_id,created_at desc);
create table public.experiment_runs(
  id uuid primary key default gen_random_uuid(), workspace_id uuid not null references public.workspaces on delete cascade,
  created_by uuid default auth.uid() references auth.users on delete set null, created_at timestamptz not null default now(),
  experiment_id uuid not null, name text not null check(length(trim(name)) between 1 and 200),
  run_date timestamptz not null default now(), replicate integer not null default 1 check(replicate>0),
  configuration jsonb not null default '{}' check(jsonb_typeof(configuration)='object'), notes text not null default '',
  foreign key(workspace_id,experiment_id) references public.experiments(workspace_id,id) on delete cascade,
  unique(workspace_id,experiment_id,id)
);
create index experiment_runs_workspace_time on public.experiment_runs(workspace_id,created_at desc);
create table public.samples(
  id uuid primary key default gen_random_uuid(), workspace_id uuid not null references public.workspaces on delete cascade,
  created_by uuid default auth.uid() references auth.users on delete set null, created_at timestamptz not null default now(),
  experiment_id uuid not null, name text not null check(length(trim(name)) between 1 and 200), notes text not null default '',
  foreign key(workspace_id,experiment_id) references public.experiments(workspace_id,id) on delete cascade, unique(workspace_id,experiment_id,id)
);
create index samples_workspace_time on public.samples(workspace_id,created_at desc);
create table public.measurements(
  id uuid primary key default gen_random_uuid(), workspace_id uuid not null references public.workspaces on delete cascade,
  created_by uuid default auth.uid() references auth.users on delete set null, created_at timestamptz not null default now(),
  experiment_id uuid not null, run_id uuid not null, variable_id uuid not null, sample_id uuid,
  value jsonb not null check(jsonb_typeof(value) in ('string','number')), 
  foreign key(workspace_id,experiment_id,run_id) references public.experiment_runs(workspace_id,experiment_id,id) on delete cascade,
  foreign key(workspace_id,experiment_id,variable_id) references public.experiment_variables(workspace_id,experiment_id,id) on delete cascade,
  foreign key(workspace_id,experiment_id,sample_id) references public.samples(workspace_id,experiment_id,id) on delete restrict,
  unique nulls not distinct (run_id,variable_id,sample_id)
);
create index measurements_workspace_time on public.measurements(workspace_id,created_at desc);
create table public.datasets(
  id uuid primary key default gen_random_uuid(), workspace_id uuid not null references public.workspaces on delete cascade,
  created_by uuid default auth.uid() references auth.users on delete set null, created_at timestamptz not null default now(),
  name text not null check(length(trim(name)) between 1 and 200), description text not null default '',
  records jsonb not null default '[]' check(jsonb_typeof(records)='array' and octet_length(records::text)<=8000000)
);
create index datasets_workspace_time on public.datasets(workspace_id,created_at desc);
create function public.valid_dataset_records(payload jsonb) returns boolean language plpgsql immutable set search_path='' as $$
declare data_row jsonb; cell record; names text[]:='{}';
begin
 if jsonb_typeof(payload)<>'array' or jsonb_array_length(payload)>5000 then return false; end if;
 for data_row in select value from jsonb_array_elements(payload) loop
  if jsonb_typeof(data_row)<>'object' or data_row='{}'::jsonb then return false; end if;
  for cell in select * from jsonb_each(data_row) loop
   if trim(cell.key)='' or cell.key in ('__proto__','constructor','prototype') or
      jsonb_typeof(cell.value) not in ('number','string','boolean','null') then return false; end if;
   if not cell.key=any(names) then
     names:=array_append(names,cell.key);
     if cardinality(names)>100 then return false; end if;
   end if;
  end loop;
 end loop;
 return true;
end $$;
revoke all on function public.valid_dataset_records(jsonb) from public,anon,authenticated;
grant execute on function public.valid_dataset_records(jsonb) to authenticated,service_role;
alter table public.datasets add constraint valid_dataset_records check(public.valid_dataset_records(records));
create table public.research_notes(
  id uuid primary key default gen_random_uuid(), workspace_id uuid not null references public.workspaces on delete cascade,
  created_by uuid default auth.uid() references auth.users on delete set null, created_at timestamptz not null default now(),
  experiment_id uuid not null, body text not null check(length(trim(body)) between 1 and 30000),
  foreign key(workspace_id,experiment_id) references public.experiments(workspace_id,id) on delete cascade
);
create index research_notes_workspace_time on public.research_notes(workspace_id,created_at desc);
create table public.activity_logs(
  id bigint generated always as identity primary key, workspace_id uuid not null references public.workspaces on delete cascade,
  actor_id uuid references auth.users on delete set null, action text not null, entity text not null,
  record_id uuid, created_at timestamptz not null default now()
);
create index activity_workspace_time on public.activity_logs(workspace_id,created_at desc);

create or replace function public.has_workspace_role(workspace_id uuid,roles text[]) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.workspace_members m where m.workspace_id=$1 and m.user_id=(select auth.uid()) and m.role=any($2))
$$;
create or replace function public.is_workspace_member(workspace_id uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.workspace_members m where m.workspace_id=$1 and m.user_id=(select auth.uid()))
$$;
create function public.can_read_profile(profile_id uuid) returns boolean language sql stable security definer set search_path='' as $$
 select $1=(select auth.uid()) or exists(select 1 from public.workspace_members a join public.workspace_members b using(workspace_id)
   where a.user_id=(select auth.uid()) and b.user_id=$1)
$$;
create function public.sync_lab_profile() returns trigger language plpgsql security definer set search_path='' as $$
begin
 insert into public.profiles(id,display_name) values(new.id,left(coalesce(new.raw_user_meta_data->>'display_name',''),160))
 on conflict(id) do nothing;
 return new;
end $$;
create trigger sync_lab_profile after insert on auth.users for each row execute function public.sync_lab_profile();
insert into public.profiles(id,display_name) select id,left(coalesce(raw_user_meta_data->>'display_name',''),160) from auth.users on conflict do nothing;

create function public.create_workspace(p_name text,p_template text) returns uuid language plpgsql security definer set search_path='' as $$
declare workspace uuid;
begin
 if auth.uid() is null then raise exception 'Sign in required' using errcode='42501'; end if;
 insert into public.workspaces(name,template,created_by) values(trim(p_name),p_template,auth.uid()) returning id into workspace;
 insert into public.workspace_members(workspace_id,user_id,role) values(workspace,auth.uid(),'owner');
 return workspace;
end $$;

create function public.invite_member(p_workspace_id uuid,p_email text,p_role text) returns text language plpgsql security definer set search_path='' as $$
declare token text:=gen_random_uuid()::text||gen_random_uuid()::text;
begin
 if not public.has_workspace_role(p_workspace_id,array['owner','administrator']) or
    (p_role='administrator' and not public.has_workspace_role(p_workspace_id,array['owner'])) then
   raise exception 'Invitation denied' using errcode='42501';
 end if;
 if length(trim(p_email))>254 or trim(p_email) !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$' then raise exception 'Invalid email'; end if;
 insert into public.workspace_invitations(workspace_id,email,role,token_hash,created_by)
 values(p_workspace_id,lower(trim(p_email)),p_role,sha256(convert_to(token,'UTF8')),auth.uid())
 on conflict(workspace_id,email) do update set role=excluded.role,token_hash=excluded.token_hash,created_by=excluded.created_by,expires_at=now()+interval '7 days';
 return token;
end $$;
create function public.accept_invitation(p_token text) returns uuid language plpgsql security definer set search_path='' as $$
declare target public.workspace_invitations; verified_email text;
begin
 select lower(email) into verified_email from auth.users where id=auth.uid() and email_confirmed_at is not null;
 select * into target from public.workspace_invitations where token_hash=sha256(convert_to(p_token,'UTF8')) and email=verified_email and expires_at>clock_timestamp() for update;
 if not found then raise exception 'Invitation unavailable' using errcode='42501'; end if;
 if not exists(select 1 from public.workspace_members m where m.workspace_id=target.workspace_id
   and m.user_id=target.created_by and (m.role='owner' or (m.role='administrator' and target.role<>'administrator'))) then
   raise exception 'Invitation unavailable' using errcode='42501';
 end if;
 if not public.is_workspace_member(target.workspace_id) then
   insert into public.workspace_members(workspace_id,user_id,role) values(target.workspace_id,auth.uid(),target.role) on conflict do nothing;
 end if;
 delete from public.workspace_invitations where id=target.id;
 return target.workspace_id;
end $$;
create function public.manage_member(p_workspace_id uuid,p_user_id uuid,p_role text,p_remove boolean)
returns void language plpgsql security definer set search_path='' as $$
declare target_role text; manager_role text;
begin
 perform 1 from public.workspaces where id=p_workspace_id for update;
 select role into manager_role from public.workspace_members where workspace_id=p_workspace_id and user_id=auth.uid();
 select role into target_role from public.workspace_members where workspace_id=p_workspace_id and user_id=p_user_id;
 if manager_role is null or manager_role not in ('owner','administrator') or target_role is null or target_role='owner'
 or (manager_role='administrator' and (target_role='administrator' or p_role='administrator')) then
   raise exception 'Membership change denied' using errcode='42501';
 end if;
 if p_remove then delete from public.workspace_members where workspace_id=p_workspace_id and user_id=p_user_id;
 else
   if p_role not in ('administrator','researcher','reviewer','viewer') or p_role is null then raise exception 'Invalid role'; end if;
   update public.workspace_members set role=p_role where workspace_id=p_workspace_id and user_id=p_user_id;
 end if;
end $$;
create function public.set_member_role(p_workspace_id uuid,p_user_id uuid,p_role text) returns void language sql security definer set search_path='' as $$
 select public.manage_member($1,$2,$3,false)
$$;
create function public.remove_member(p_workspace_id uuid,p_user_id uuid) returns void language sql security definer set search_path='' as $$
 select public.manage_member($1,$2,'viewer',true)
$$;
create function public.revoke_invitation(p_workspace_id uuid,p_email text) returns void language plpgsql security definer set search_path='' as $$
begin
 if not public.has_workspace_role(p_workspace_id,array['owner','administrator']) then raise exception 'Permission denied' using errcode='42501'; end if;
 delete from public.workspace_invitations where workspace_id=p_workspace_id and email=lower(trim(p_email));
end $$;
revoke all on function public.revoke_invitation(uuid,text) from public,anon,authenticated;
grant execute on function public.revoke_invitation(uuid,text) to authenticated;
create function public.transfer_workspace(p_workspace_id uuid,p_new_owner uuid) returns void language plpgsql security definer set search_path='' as $$
begin
 perform 1 from public.workspaces where id=p_workspace_id for update;
 if not public.has_workspace_role(p_workspace_id,array['owner']) then raise exception 'Owner permission required' using errcode='42501'; end if;
 if p_new_owner=auth.uid() then return; end if;
 perform 1 from public.workspace_members where workspace_id=p_workspace_id and user_id=p_new_owner for update;
 if not found then raise exception 'Choose an existing workspace member'; end if;
 update public.workspace_members set role='administrator' where workspace_id=p_workspace_id and user_id=auth.uid();
 update public.workspace_members set role='owner' where workspace_id=p_workspace_id and user_id=p_new_owner;
end $$;
revoke all on function public.transfer_workspace(uuid,uuid) from public,anon,authenticated;
grant execute on function public.transfer_workspace(uuid,uuid) to authenticated;
create function public.check_measurement_value() returns trigger language plpgsql set search_path='' as $$
declare kind_name text; raw_val text:=new.value #>> '{}';
begin
 select kind into strict kind_name from public.experiment_variables where id=new.variable_id and workspace_id=new.workspace_id and experiment_id=new.experiment_id;
 if (kind_name='numeric' and jsonb_typeof(new.value)<>'number') or (kind_name<>'numeric' and jsonb_typeof(new.value)<>'string') then raise exception 'Value has wrong type'; end if;
 if kind_name='datetime' then
   if raw_val !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}([T ][0-9]{2}:[0-9]{2}.*)?$' then raise exception 'Use an ISO date or timestamp'; end if;
   perform raw_val::timestamptz;
 end if;
 return new;
end $$;
create trigger validate_measurement before insert or update on public.measurements for each row execute function public.check_measurement_value();

-- An invalid field rolls back both the run and all its measurements.
-- SECURITY INVOKER applies the same table permissions and RLS as normal inserts.
create function public.record_run(p_workspace_id uuid,p_experiment_id uuid,p_name text,p_replicate int,
  p_run_date timestamptz,p_configuration jsonb,p_notes text,p_values jsonb)
returns uuid language plpgsql security invoker set search_path='' as $$
declare run_id uuid;
begin
 if jsonb_typeof(p_values) is distinct from 'object' then raise exception 'Measurements must be an object'; end if;
 insert into public.experiment_runs(workspace_id,experiment_id,name,replicate,run_date,configuration,notes)
 values(p_workspace_id,p_experiment_id,p_name,p_replicate,p_run_date,p_configuration,p_notes) returning id into run_id;
 insert into public.measurements(workspace_id,experiment_id,run_id,variable_id,value)
 select p_workspace_id,p_experiment_id,run_id,fields.key::uuid,fields.value from jsonb_each(p_values) fields;
 return run_id;
end $$;
revoke all on function public.record_run(uuid,uuid,text,int,timestamptz,jsonb,text,jsonb) from public,anon,authenticated;
grant execute on function public.record_run(uuid,uuid,text,int,timestamptz,jsonb,text,jsonb) to authenticated;

create function public.log_lab_activity() returns trigger language plpgsql security definer set search_path='' as $$
declare row_info jsonb; workspace uuid; record uuid;
begin
 row_info:=case when tg_op='DELETE' then to_jsonb(old) else to_jsonb(new) end;
 workspace:=(row_info->>'workspace_id')::uuid;
 record:=coalesce((row_info->>'id')::uuid,(row_info->>'user_id')::uuid);
 if exists(select 1 from public.workspaces where id=workspace) then
   insert into public.activity_logs(workspace_id,actor_id,action,entity,record_id) values(workspace,auth.uid(),lower(tg_op),tg_table_name,record);
 end if;
 return null;
end $$;

alter table public.profiles enable row level security;
revoke all on public.profiles from public,anon,authenticated;
alter table public.workspaces enable row level security;
revoke all on public.workspaces from public,anon,authenticated;
alter table public.workspace_members enable row level security;
revoke all on public.workspace_members from public,anon,authenticated;
alter table public.workspace_invitations enable row level security;
revoke all on public.workspace_invitations from public,anon,authenticated;
alter table public.activity_logs enable row level security;
revoke all on public.activity_logs from public,anon,authenticated;
alter table public.projects enable row level security;
revoke all on public.projects from public,anon,authenticated;
alter table public.experiments enable row level security;
revoke all on public.experiments from public,anon,authenticated;
alter table public.experiment_variables enable row level security;
revoke all on public.experiment_variables from public,anon,authenticated;
alter table public.experiment_runs enable row level security;
revoke all on public.experiment_runs from public,anon,authenticated;
alter table public.samples enable row level security;
revoke all on public.samples from public,anon,authenticated;
alter table public.measurements enable row level security;
revoke all on public.measurements from public,anon,authenticated;
alter table public.datasets enable row level security;
revoke all on public.datasets from public,anon,authenticated;
alter table public.research_notes enable row level security;
revoke all on public.research_notes from public,anon,authenticated;
grant select on public.profiles,public.workspaces,public.workspace_members,public.activity_logs to authenticated;
grant select(id,workspace_id,email,role,created_by,expires_at) on public.workspace_invitations to authenticated;
create policy invitations_admin_read on public.workspace_invitations for select to authenticated using(public.has_workspace_role(workspace_id,array['owner','administrator']));
grant update(display_name) on public.profiles to authenticated;
grant update(name,template) on public.workspaces to authenticated;
create policy profile_read on public.profiles for select to authenticated using(public.can_read_profile(id));
create policy profile_own on public.profiles for update to authenticated using(id=auth.uid()) with check(id=auth.uid());
create policy workspace_read on public.workspaces for select to authenticated using(public.is_workspace_member(id));
create policy workspace_settings on public.workspaces for update to authenticated using(public.has_workspace_role(id,array['owner','administrator'])) with check(public.has_workspace_role(id,array['owner','administrator']));
create policy members_read on public.workspace_members for select to authenticated using(public.is_workspace_member(workspace_id));
create policy activity_read on public.activity_logs for select to authenticated using(public.is_workspace_member(workspace_id));

grant select,insert,delete on public.projects to authenticated;
grant update(name,objectives) on public.projects to authenticated;
create policy member_read on public.projects for select to authenticated using(public.is_workspace_member(workspace_id));
create policy writer_insert on public.projects for insert to authenticated with check(created_by=auth.uid() and public.has_workspace_role(workspace_id,array['owner','administrator','researcher']));
create policy writer_update on public.projects for update to authenticated using(public.has_workspace_role(workspace_id,array['owner','administrator','researcher'])) with check(public.has_workspace_role(workspace_id,array['owner','administrator','researcher']));
create policy manager_delete on public.projects for delete to authenticated using(public.has_workspace_role(workspace_id,array['owner','administrator']));
grant select,insert,delete on public.experiments to authenticated;
grant update(name,description,objectives,research_question,procedure_text,conditions,notes) on public.experiments to authenticated;
create policy member_read on public.experiments for select to authenticated using(public.is_workspace_member(workspace_id));
create policy writer_insert on public.experiments for insert to authenticated with check(created_by=auth.uid() and public.has_workspace_role(workspace_id,array['owner','administrator','researcher']));
create policy writer_update on public.experiments for update to authenticated using(public.has_workspace_role(workspace_id,array['owner','administrator','researcher'])) with check(public.has_workspace_role(workspace_id,array['owner','administrator','researcher']));
create policy manager_delete on public.experiments for delete to authenticated using(public.has_workspace_role(workspace_id,array['owner','administrator']));
grant select,insert,delete on public.experiment_variables to authenticated;
grant update(name,variable_role) on public.experiment_variables to authenticated;
create policy member_read on public.experiment_variables for select to authenticated using(public.is_workspace_member(workspace_id));
create policy writer_insert on public.experiment_variables for insert to authenticated with check(created_by=auth.uid() and public.has_workspace_role(workspace_id,array['owner','administrator','researcher']));
create policy writer_update on public.experiment_variables for update to authenticated using(public.has_workspace_role(workspace_id,array['owner','administrator','researcher'])) with check(public.has_workspace_role(workspace_id,array['owner','administrator','researcher']));
create policy manager_delete on public.experiment_variables for delete to authenticated using(public.has_workspace_role(workspace_id,array['owner','administrator']));
grant select,insert,delete on public.experiment_runs to authenticated;
grant update(name,run_date,replicate,configuration,notes) on public.experiment_runs to authenticated;
create policy member_read on public.experiment_runs for select to authenticated using(public.is_workspace_member(workspace_id));
create policy writer_insert on public.experiment_runs for insert to authenticated with check(created_by=auth.uid() and public.has_workspace_role(workspace_id,array['owner','administrator','researcher']));
create policy writer_update on public.experiment_runs for update to authenticated using(public.has_workspace_role(workspace_id,array['owner','administrator','researcher'])) with check(public.has_workspace_role(workspace_id,array['owner','administrator','researcher']));
create policy manager_delete on public.experiment_runs for delete to authenticated using(public.has_workspace_role(workspace_id,array['owner','administrator']));
grant select,insert,delete on public.samples to authenticated;
grant update(name,notes) on public.samples to authenticated;
create policy member_read on public.samples for select to authenticated using(public.is_workspace_member(workspace_id));
create policy writer_insert on public.samples for insert to authenticated with check(created_by=auth.uid() and public.has_workspace_role(workspace_id,array['owner','administrator','researcher']));
create policy writer_update on public.samples for update to authenticated using(public.has_workspace_role(workspace_id,array['owner','administrator','researcher'])) with check(public.has_workspace_role(workspace_id,array['owner','administrator','researcher']));
create policy manager_delete on public.samples for delete to authenticated using(public.has_workspace_role(workspace_id,array['owner','administrator']));
grant select,insert,delete on public.measurements to authenticated;
grant update(value) on public.measurements to authenticated;
create policy member_read on public.measurements for select to authenticated using(public.is_workspace_member(workspace_id));
create policy writer_insert on public.measurements for insert to authenticated with check(created_by=auth.uid() and public.has_workspace_role(workspace_id,array['owner','administrator','researcher']));
create policy writer_update on public.measurements for update to authenticated using(public.has_workspace_role(workspace_id,array['owner','administrator','researcher'])) with check(public.has_workspace_role(workspace_id,array['owner','administrator','researcher']));
create policy manager_delete on public.measurements for delete to authenticated using(public.has_workspace_role(workspace_id,array['owner','administrator']));
grant select,insert,delete on public.datasets to authenticated;
grant update(name,description,records) on public.datasets to authenticated;
create policy member_read on public.datasets for select to authenticated using(public.is_workspace_member(workspace_id));
create policy writer_insert on public.datasets for insert to authenticated with check(created_by=auth.uid() and public.has_workspace_role(workspace_id,array['owner','administrator','researcher']));
create policy writer_update on public.datasets for update to authenticated using(public.has_workspace_role(workspace_id,array['owner','administrator','researcher'])) with check(public.has_workspace_role(workspace_id,array['owner','administrator','researcher']));
create policy manager_delete on public.datasets for delete to authenticated using(public.has_workspace_role(workspace_id,array['owner','administrator']));
grant select,insert,delete on public.research_notes to authenticated;
grant update(body) on public.research_notes to authenticated;
create policy member_read on public.research_notes for select to authenticated using(public.is_workspace_member(workspace_id));
create policy writer_insert on public.research_notes for insert to authenticated with check(created_by=auth.uid() and public.has_workspace_role(workspace_id,array['owner','administrator','researcher','reviewer']));
create policy writer_update on public.research_notes for update to authenticated using((public.has_workspace_role(workspace_id,array['owner','administrator']) or (created_by=auth.uid() and public.has_workspace_role(workspace_id,array['researcher','reviewer'])))) with check((public.has_workspace_role(workspace_id,array['owner','administrator']) or (created_by=auth.uid() and public.has_workspace_role(workspace_id,array['researcher','reviewer']))));
create policy manager_delete on public.research_notes for delete to authenticated using((public.has_workspace_role(workspace_id,array['owner','administrator']) or (created_by=auth.uid() and public.has_workspace_role(workspace_id,array['researcher','reviewer']))));
create trigger audit_projects after insert or update or delete on public.projects for each row execute function public.log_lab_activity();
create trigger audit_experiments after insert or update or delete on public.experiments for each row execute function public.log_lab_activity();
create trigger audit_experiment_variables after insert or update or delete on public.experiment_variables for each row execute function public.log_lab_activity();
create trigger audit_experiment_runs after insert or update or delete on public.experiment_runs for each row execute function public.log_lab_activity();
create trigger audit_samples after insert or update or delete on public.samples for each row execute function public.log_lab_activity();
create trigger audit_measurements after insert or update or delete on public.measurements for each row execute function public.log_lab_activity();
create trigger audit_datasets after insert or update or delete on public.datasets for each row execute function public.log_lab_activity();
create trigger audit_research_notes after insert or update or delete on public.research_notes for each row execute function public.log_lab_activity();
create trigger audit_workspace_members after insert or update or delete on public.workspace_members for each row execute function public.log_lab_activity();
create trigger audit_workspace_invitations after insert or update or delete on public.workspace_invitations for each row execute function public.log_lab_activity();
revoke all on function public.has_workspace_role(uuid,text[]) from public,anon,authenticated;
revoke all on function public.is_workspace_member(uuid) from public,anon,authenticated;
revoke all on function public.can_read_profile(uuid) from public,anon,authenticated;
revoke all on function public.sync_lab_profile() from public,anon,authenticated;
revoke all on function public.create_workspace(text,text) from public,anon,authenticated;
revoke all on function public.invite_member(uuid,text,text) from public,anon,authenticated;
revoke all on function public.accept_invitation(text) from public,anon,authenticated;
revoke all on function public.manage_member(uuid,uuid,text,boolean) from public,anon,authenticated;
revoke all on function public.set_member_role(uuid,uuid,text) from public,anon,authenticated;
revoke all on function public.remove_member(uuid,uuid) from public,anon,authenticated;
revoke all on function public.check_measurement_value() from public,anon,authenticated;
revoke all on function public.log_lab_activity() from public,anon,authenticated;
grant execute on function public.has_workspace_role(uuid,text[]) to authenticated;
grant execute on function public.is_workspace_member(uuid) to authenticated;
grant execute on function public.can_read_profile(uuid) to authenticated;
grant execute on function public.create_workspace(text,text) to authenticated;
grant execute on function public.invite_member(uuid,text,text) to authenticated;
grant execute on function public.accept_invitation(text) to authenticated;
grant execute on function public.set_member_role(uuid,uuid,text) to authenticated;
grant execute on function public.remove_member(uuid,uuid) to authenticated;
commit;

