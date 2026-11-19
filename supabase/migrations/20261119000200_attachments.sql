-- Private, small research documents. Whole slides use the R2 job workflow.
begin;
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values ('experiment-attachments','experiment-attachments',false,10485760,
 array['application/pdf','text/plain','text/csv','application/json',
       'application/vnd.openxmlformats-officedocument.wordprocessingml.document','image/png','image/jpeg']);

create function public.attachment_workspace(object_name text) returns uuid language sql stable security invoker set search_path='' as $$
 select e.workspace_id from public.experiments e
 where e.workspace_id::text=split_part(object_name,'/',1)
   and e.id::text=split_part(object_name,'/',2)
   and cardinality(string_to_array(object_name,'/'))=3
   and split_part(object_name,'/',3) ~* '^[a-f0-9-]{36}-[a-z0-9._-]{1,140}$'
   and split_part(object_name,'/',3) ~* '[.](pdf|txt|csv|json|docx|png|jpe?g)$'
$$;
revoke all on function public.attachment_workspace(text) from public,anon,authenticated;
grant execute on function public.attachment_workspace(text) to authenticated;
create policy stegasus_attachment_read on storage.objects for select to authenticated using(
 bucket_id='experiment-attachments' and public.attachment_workspace(name) is not null
);
create policy stegasus_attachment_upload on storage.objects for insert to authenticated with check(
 bucket_id='experiment-attachments' and public.has_workspace_role(public.attachment_workspace(name),array['owner','administrator','researcher'])
);
create policy stegasus_attachment_remove on storage.objects for delete to authenticated using(
 bucket_id='experiment-attachments' and (
  public.has_workspace_role(public.attachment_workspace(name),array['owner','administrator'])
  or (owner_id=(select auth.uid())::text and public.has_workspace_role(public.attachment_workspace(name),array['researcher']))
 )
);

-- Retain the experiment while files exist so the team can still remove them
-- through the Storage API, which cleans up the underlying binary too.
create function public.check_experiment_files() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if exists(select 1 from storage.objects where bucket_id='experiment-attachments'
     and name like old.workspace_id::text||'/'||old.id::text||'/%') then
   raise exception 'Remove the experiment attachments before deleting this record';
 end if;
 return old;
end $$;
revoke all on function public.check_experiment_files() from public,anon,authenticated;
create trigger check_experiment_files before delete on public.experiments for each row execute function public.check_experiment_files();
commit;
