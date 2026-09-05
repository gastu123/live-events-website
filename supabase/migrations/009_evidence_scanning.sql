-- Create evidence scanning audit log table
-- This table tracks all malware scans performed on uploaded payment evidence

begin;

create table if not exists evidence_scan_logs(
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references manual_payment_submissions(id) on delete cascade,
  scan_status text not null check(scan_status in ('clean','rejected','error')),
  clean boolean not null,
  malicious_count int not null default 0,
  suspicious_count int not null default 0,
  vendor_results jsonb not null default '{}',
  error_message text,
  scanned_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists idx_evidence_scan_logs_submission_id on evidence_scan_logs(submission_id);
create index if not exists idx_evidence_scan_logs_scanned_at on evidence_scan_logs(scanned_at desc);
create index if not exists idx_evidence_scan_logs_scan_status on evidence_scan_logs(scan_status);

-- Enable RLS
alter table evidence_scan_logs enable row level security;

-- Only service role can access logs
create policy "Service role can access evidence scan logs" on evidence_scan_logs
  for all using (auth.role() = 'service_role');

commit;
