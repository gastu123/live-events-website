begin;

alter table payment_assignments
  drop constraint if exists payment_assignments_gift_card_instructions_check;

commit;
