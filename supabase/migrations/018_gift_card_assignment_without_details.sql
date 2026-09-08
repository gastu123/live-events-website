begin;

alter table payment_assignments
  alter column account_name drop not null,
  alter column payment_identifier drop not null;

alter table payment_assignments
  drop constraint if exists payment_assignments_account_name_check,
  drop constraint if exists payment_assignments_identifier_check;

alter table payment_assignments
  add constraint payment_assignments_account_name_check
    check(account_name is null or char_length(account_name) between 2 and 160),
  add constraint payment_assignments_identifier_check
    check(payment_identifier is null or char_length(payment_identifier) between 2 and 500);

commit;
