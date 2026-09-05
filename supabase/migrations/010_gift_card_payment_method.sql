begin;

alter table payments drop constraint if exists payments_method_check;
alter table payments
  add constraint payments_method_check
    check(method in ('paypal','card','cash_app','chime','bank_transfer','gift_card'));

alter table payment_assignments drop constraint if exists payment_assignments_method_check;
alter table payment_assignments
  add constraint payment_assignments_method_check
    check(payment_method in ('paypal','cash_app','chime','bank_transfer','gift_card'));

alter table payment_assignments
  add constraint payment_assignments_gift_card_instructions_check
    check(payment_method <> 'gift_card' or char_length(instructions) between 2 and 2000);

commit;
