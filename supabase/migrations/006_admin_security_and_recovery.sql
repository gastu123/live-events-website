begin;

alter table admin_users
  add column if not exists recovery_email text,
  add column if not exists recovery_phone text,
  add column if not exists recovery_phone_hash char(64),
  add column if not exists invited_by uuid references admin_users(id),
  add column if not exists deactivated_by uuid references admin_users(id),
  add column if not exists deactivated_at timestamptz,
  add column if not exists sessions_invalidated_at timestamptz;

create unique index if not exists admin_recovery_email_unique
  on admin_users(lower(recovery_email))
  where recovery_email is not null and deleted_at is null;
create unique index if not exists admin_recovery_phone_hash_unique
  on admin_users(recovery_phone_hash)
  where recovery_phone_hash is not null and deleted_at is null;

alter table admin_login_attempts
  add column if not exists admin_user_id uuid references admin_users(id);
create index if not exists admin_login_attempts_admin_idx
  on admin_login_attempts(admin_user_id, created_at desc);

create table if not exists admin_password_otps(
  id uuid primary key,
  admin_user_id uuid not null references admin_users(id),
  otp_hash char(64) not null,
  requested_ip_hash char(64) not null,
  expires_at timestamptz not null,
  resend_available_at timestamptz not null,
  attempts smallint not null default 0 check(attempts between 0 and 5),
  verified_at timestamptz,
  used_at timestamptz,
  reset_token_hash char(64),
  reset_expires_at timestamptz,
  created_at timestamptz not null default now(),
  check(expires_at > created_at)
);
create index if not exists admin_password_otps_admin_idx
  on admin_password_otps(admin_user_id, created_at desc);
create index if not exists admin_password_otps_ip_idx
  on admin_password_otps(requested_ip_hash, created_at desc);
alter table admin_password_otps enable row level security;

drop index if exists one_super_admin;
drop trigger if exists protect_super_admin on admin_users;
create or replace function public.protect_final_super_admin()
returns trigger language plpgsql as $$
declare other_active_supers integer;
begin
  if old.is_super_admin and old.status='active' and old.deleted_at is null
     and (tg_op='DELETE' or not coalesce(new.is_super_admin,false)
       or coalesce(new.status,'disabled') <> 'active'
       or new.deleted_at is not null) then
    select count(*) into other_active_supers
      from admin_users
      where id <> old.id and is_super_admin=true and status='active' and deleted_at is null;
    if other_active_supers = 0 then
      raise exception 'The final active Super Administrator is protected' using errcode='23514';
    end if;
  end if;
  return case when tg_op='DELETE' then old else new end;
end $$;
create trigger protect_final_super_admin
  before update or delete on admin_users
  for each row execute function public.protect_final_super_admin();

commit;
