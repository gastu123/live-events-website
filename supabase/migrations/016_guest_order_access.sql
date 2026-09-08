begin;

alter table orders
  add column if not exists guest_access_token_hash char(64);

create unique index if not exists orders_guest_access_token_hash_idx
  on orders(guest_access_token_hash)
  where guest_access_token_hash is not null;

commit;