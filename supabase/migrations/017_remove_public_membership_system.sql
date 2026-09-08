begin;

drop function if exists public.expire_memberships();
drop table if exists memberships;
drop table if exists membership_applications;

commit;