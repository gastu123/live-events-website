begin;

alter table payment_assignments
  add column if not exists bank_name text,
  add column if not exists account_number text;

alter table payment_assignments alter column account_name drop not null;
alter table payment_assignments alter column payment_identifier drop not null;

alter table payment_assignments
  add constraint payment_assignments_bank_name_check
    check(bank_name is null or char_length(bank_name) between 2 and 160),
  add constraint payment_assignments_account_number_check
    check(account_number is null or char_length(account_number) between 4 and 100);

commit;
