begin;

create unique index if not exists one_super_admin_global
  on admin_users(is_super_admin)
  where is_super_admin=true;

create or replace function public.enforce_super_admin_role()
returns trigger language plpgsql as $$
declare super_role_id uuid;
begin
  select id into super_role_id from admin_roles where name='Super Administrator';
  if new.is_super_admin and new.role_id <> super_role_id then
    raise exception 'Super Administrator flag requires the protected Super Administrator role' using errcode='23514';
  end if;
  if new.role_id = super_role_id and not new.is_super_admin then
    raise exception 'The protected Super Administrator role cannot be assigned' using errcode='23514';
  end if;
  return new;
end $$;

create trigger enforce_super_admin_role
  before insert or update of role_id,is_super_admin on admin_users
  for each row execute function public.enforce_super_admin_role();

commit;
