begin;

alter table orders drop constraint if exists orders_status_check;
alter table orders drop constraint if exists orders_payment_status_check;
alter table payments drop constraint if exists payments_status_check;

update orders set status='pending_verification' where status='payment_under_review';
update orders set payment_status='pending_verification' where payment_status='verification_required';
update payments set status='pending_verification' where status='verification_required';

alter table orders add constraint orders_status_check check (status in (
  'pending_payment','awaiting_payment_details','payment_details_ready',
  'pending_verification','provider_verified','payment_successful',
  'payment_rejected','payment_details_expired','payment_failed','cancelled'
));
alter table orders add constraint orders_payment_status_check check (payment_status in (
  'pending','awaiting_payment_details','payment_details_ready',
  'pending_verification','provider_verified','successful','rejected',
  'payment_details_expired','failed','cancelled','refunded','partially_refunded'
));

alter table payments add column if not exists capture_requested_at timestamptz;
alter table payments add constraint payments_status_check check (status in (
  'pending','awaiting_payment_details','payment_details_ready',
  'pending_verification','provider_verified','successful','rejected',
  'payment_details_expired','failed','cancelled','refunded','partially_refunded'
));

alter table manual_payment_submissions
  add column if not exists transaction_reference text,
  add column if not exists evidence_sha256 char(64),
  add column if not exists evidence_scan_status text not null default 'pending'
    check(evidence_scan_status in ('pending','clean','rejected'));
create unique index if not exists manual_submission_reference_unique
  on manual_payment_submissions(lower(transaction_reference))
  where transaction_reference is not null;
create unique index if not exists manual_submission_evidence_unique
  on manual_payment_submissions(evidence_sha256)
  where evidence_sha256 is not null;
create unique index if not exists manual_submission_storage_unique
  on manual_payment_submissions(evidence_storage_path)
  where evidence_storage_path is not null;

create table payment_destinations(
  id uuid primary key default gen_random_uuid(),
  provider text not null check(provider in ('cash_app','chime')),
  display_label text not null,
  public_instructions text not null,
  currency char(3) not null,
  verification_status text not null default 'draft' check(verification_status in ('draft','unverified','verified')),
  enabled boolean not null default false,
  created_by uuid not null references admin_users(id),
  updated_by uuid not null references admin_users(id),
  verified_by uuid references admin_users(id),
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  check(public_instructions !~* '(account|routing)[[:space:]_-]*number'),
  check((verification_status='verified')=(verified_by is not null and verified_at is not null)),
  check(not enabled or verification_status='verified')
);
create index payment_destinations_available_idx on payment_destinations(provider,currency)
  where enabled and verification_status='verified' and deleted_at is null;

create table payment_assignments(
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id),
  payment_id uuid not null references payments(id),
  destination_id uuid not null references payment_destinations(id),
  assigned_by uuid not null references admin_users(id),
  payment_reference text not null unique,
  amount_minor bigint not null check(amount_minor>0),
  currency char(3) not null,
  status text not null default 'active' check(status in ('active','expired','submitted','completed','rejected')),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check(expires_at>created_at)
);
create unique index payment_assignments_one_active on payment_assignments(order_id)
  where status in ('active','submitted');
create index payment_assignments_queue_idx on payment_assignments(status,expires_at);

create table payment_evidence_access_logs(
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references manual_payment_submissions(id),
  admin_user_id uuid not null references admin_users(id),
  request_id text,
  accessed_at timestamptz not null default now()
);
create index evidence_access_submission_idx on payment_evidence_access_logs(submission_id,accessed_at desc);

insert into admin_permissions(code,description) values
  ('payments.destinations.manage','Manage and verify manual payment destinations'),
  ('payments.assign','Assign verified payment instructions to orders'),
  ('payments.final_approve','Give final approval to provider-verified payments')
on conflict(code) do nothing;

insert into admin_role_permissions(role_id,permission_id)
select ar.id,ap.id from admin_roles ar cross join admin_permissions ap
where ar.name='Finance Manager' and ap.code in ('payments.destinations.manage','payments.assign','payments.final_approve')
on conflict do nothing;

create trigger payment_destinations_updated before update on payment_destinations
for each row execute function public.set_updated_at();
create trigger payment_assignments_updated before update on payment_assignments
for each row execute function public.set_updated_at();

alter table payment_destinations enable row level security;
alter table payment_assignments enable row level security;
alter table payment_evidence_access_logs enable row level security;
create policy payment_assignments_owner_select on payment_assignments for select using (
  exists(select 1 from orders where orders.id=payment_assignments.order_id and orders.profile_id=auth.uid())
);

create or replace function public.expire_payment_assignments() returns integer
language plpgsql security definer set search_path=public as $$
declare expired_count integer;
begin
  with expired as (
    update payment_assignments set status='expired',updated_at=now()
    where status='active' and expires_at<=now() returning order_id,payment_id
  ), payment_updates as (
    update payments p set status='payment_details_expired',updated_at=now()
    from expired e where p.id=e.payment_id returning p.order_id
  )
  update orders set status='payment_details_expired',payment_status='payment_details_expired',updated_at=now()
  where id in(select order_id from payment_updates);
  get diagnostics expired_count=row_count;
  return expired_count;
end $$;

commit;
