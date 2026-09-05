begin;
-- Create the private evidence bucket in the Supabase dashboard or with a privileged migration.
-- Never make manual-payment evidence public. Signed URLs must be short-lived and admin-authorised.
-- If pg_cron is enabled by the project owner, schedule:
-- select cron.schedule('release-order-holds','* * * * *','select public.release_expired_order_holds()');
commit;
