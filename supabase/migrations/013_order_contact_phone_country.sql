begin;

alter table orders
  add column if not exists contact_phone text,
  add column if not exists contact_country char(2);

commit;
