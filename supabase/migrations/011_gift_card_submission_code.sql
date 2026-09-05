begin;

alter table manual_payment_submissions
  add column if not exists gift_card_code text;

alter table manual_payment_submissions
  add constraint manual_submission_gift_card_code_check
    check(gift_card_code is null or char_length(gift_card_code) between 4 and 200);

commit;
