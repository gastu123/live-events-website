begin;

alter table payments drop constraint if exists payments_method_check;
alter table payments add constraint payments_method_check check(
  method in ('paypal','card','cash_app','chime','bank_transfer')
);

update payments set
  provider='manual',
  method=case when method='card' then 'bank_transfer' else method end,
  status='awaiting_payment_details',
  provider_reference=null,
  capture_requested_at=null,
  updated_at=now()
where provider<>'manual'
  and status not in ('successful','refunded','partially_refunded','cancelled');

update orders o set
  status='awaiting_payment_details',
  payment_status='awaiting_payment_details',
  updated_at=now()
where exists(
  select 1 from payments p where p.order_id=o.id
  and p.provider='manual' and p.status='awaiting_payment_details'
);

alter table payment_assignments alter column destination_id drop not null;
alter table payment_assignments
  add column if not exists payment_method text,
  add column if not exists account_name text,
  add column if not exists payment_identifier text,
  add column if not exists instructions text;

update payment_assignments pa set
  payment_method=pd.provider,
  account_name=pd.display_label,
  payment_identifier=pd.public_instructions
from payment_destinations pd
where pa.destination_id=pd.id and pa.payment_method is null;

alter table payment_assignments
  add constraint payment_assignments_method_check
    check(payment_method in ('paypal','cash_app','chime','bank_transfer')),
  add constraint payment_assignments_account_name_check
    check(char_length(account_name) between 2 and 160),
  add constraint payment_assignments_identifier_check
    check(char_length(payment_identifier) between 2 and 500),
  add constraint payment_assignments_instructions_check
    check(instructions is null or char_length(instructions)<=2000);

alter table payment_assignments alter column payment_method set not null;
alter table payment_assignments alter column account_name set not null;
alter table payment_assignments alter column payment_identifier set not null;

comment on column payment_assignments.payment_identifier is
  'Administrator-assigned off-site receiving identifier. Owner-only through the API and RLS.';

commit;
