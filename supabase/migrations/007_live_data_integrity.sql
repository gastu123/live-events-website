begin;

drop trigger if exists protect_final_super_admin on admin_users;
drop function if exists public.protect_final_super_admin();

create or replace function public.protect_super_admin_account()
returns trigger language plpgsql as $$
declare other_active_supers integer;
begin
  if old.is_super_admin and
     (tg_op='DELETE' or coalesce(new.status,'disabled') <> 'active' or new.deleted_at is not null) then
    raise exception 'A Super Administrator cannot be deleted or deactivated' using errcode='23514';
  end if;
  if old.is_super_admin and tg_op='UPDATE' and not coalesce(new.is_super_admin,false) then
    select count(*) into other_active_supers
      from admin_users
      where id <> old.id and is_super_admin=true and status='active' and deleted_at is null;
    if other_active_supers = 0 then
      raise exception 'The final active Super Administrator cannot be demoted' using errcode='23514';
    end if;
  end if;
  return case when tg_op='DELETE' then old else new end;
end $$;

create trigger protect_super_admin_account
  before update or delete on admin_users
  for each row execute function public.protect_super_admin_account();

commit;
