begin;

alter table profiles alter column country type text using country::text;
alter table membership_applications alter column country type text using country::text;
alter table orders alter column contact_country type text using contact_country::text;
alter table admin_users add column if not exists recovery_phone_country text;

commit;
