-- Only the Edge Function may mutate inference or see credentials and lease tokens.
create table public.inference_jobs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete restrict,
  project_id uuid not null, experiment_id uuid,
  created_by uuid references auth.users(id) on delete set null,
  case_id text not null check(length(case_id) between 1 and 100),
  filename text not null check(length(filename) between 1 and 200),
  size_bytes bigint not null check(size_bytes > 0),
  status text not null default 'uploading' check(status in ('uploading','queued','processing','completed','failed','cancelled')),
  object_key text not null unique,
  upload_id text, worker_id text, lease_token uuid, lease_until timestamptz,
  attempts int not null default 0, object_present boolean not null default false,
  result jsonb, artifacts jsonb not null default '[]', error text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  foreign key (workspace_id,project_id) references public.projects(workspace_id,id) on delete restrict,
  foreign key (workspace_id,experiment_id) references public.experiments(workspace_id,id) on delete restrict
);
create index inference_project_time on public.inference_jobs(project_id,created_at desc);
create index inference_claimable on public.inference_jobs(workspace_id,status,created_at);
create table public.inference_workers (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  worker_id text not null, last_seen timestamptz not null default now(), primary key(workspace_id,worker_id)
);
alter table public.inference_jobs enable row level security;
alter table public.inference_workers enable row level security;
revoke all on public.inference_jobs,public.inference_workers from anon,authenticated,public;
grant select(id,workspace_id,project_id,experiment_id,created_by,case_id,filename,size_bytes,status,result,error,created_at,updated_at) on public.inference_jobs to authenticated;
grant select on public.inference_workers to authenticated;
grant all on public.inference_jobs,public.inference_workers to service_role;
create policy inference_read on public.inference_jobs for select to authenticated using(public.is_workspace_member(workspace_id));
create policy workers_read on public.inference_workers for select to authenticated using(public.is_workspace_member(workspace_id));

create function public.reserve_inference(p_id uuid,p_workspace uuid,p_project uuid,p_user uuid,p_case text,p_file text,p_size bigint,p_workspace_limit bigint,p_global_limit bigint)
returns void language plpgsql set search_path='' as $$
declare reserved bigint; global_reserved bigint;
begin
  -- Serialize the single budget reservation, including simultaneous uploads in different laboratories.
  perform pg_catalog.pg_advisory_xact_lock(792605431);
  select coalesce(sum(size_bytes) filter(where workspace_id=p_workspace),0),coalesce(sum(size_bytes),0)
    into reserved,global_reserved from public.inference_jobs where status='uploading' or object_present;
  if reserved + p_size > p_workspace_limit or global_reserved + p_size > p_global_limit then
    raise exception 'Upload budget reached' using errcode='P0001';
  end if;
  if (select count(*) from public.inference_jobs where created_by=p_user and created_at>now()-interval '1 hour')>=12 then
    raise exception 'Hourly submission limit reached' using errcode='P0001';
  end if;
  insert into public.inference_jobs(id,workspace_id,project_id,created_by,case_id,filename,size_bytes,object_key)
    values(p_id,p_workspace,p_project,p_user,p_case,p_file,p_size,p_workspace::text||'/'||p_id::text||'/slide.tif');
end $$;

create function public.claim_inference(p_workspace uuid,p_worker text)
returns setof public.inference_jobs language plpgsql set search_path='' as $$
begin
  update public.inference_jobs set status='failed',error='Worker lease expired after three attempts.',lease_token=null,lease_until=null,updated_at=now()
    where workspace_id=p_workspace and status='processing' and lease_until<now() and attempts>=3;
  return query
    with candidate as (
      select id from public.inference_jobs where workspace_id=p_workspace and
        (status='queued' or (status='processing' and lease_until<now() and attempts<3))
        order by created_at for update skip locked limit 1
    )
    update public.inference_jobs j set status='processing',worker_id=p_worker,
      lease_token=gen_random_uuid(),lease_until=now()+interval '5 minutes',updated_at=now(),attempts=attempts+1
      from candidate where j.id=candidate.id returning j.*;
end $$;
revoke all on function public.claim_inference(uuid,text),public.reserve_inference(uuid,uuid,uuid,uuid,text,text,bigint,bigint,bigint) from public,anon,authenticated;
grant execute on function public.claim_inference(uuid,text),public.reserve_inference(uuid,uuid,uuid,uuid,text,text,bigint,bigint,bigint) to service_role;
