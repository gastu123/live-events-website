begin;

create table if not exists newsletter_subscribers(
  id uuid primary key default gen_random_uuid(),
  email text not null,
  status text not null default 'active' check(status in ('active','unsubscribed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists newsletter_subscribers_status_idx on newsletter_subscribers(status,created_at desc);
create unique index if not exists newsletter_subscribers_email_unique on newsletter_subscribers(lower(email));

create trigger newsletter_subscribers_updated before update on newsletter_subscribers
for each row execute function public.set_updated_at();

commit;
