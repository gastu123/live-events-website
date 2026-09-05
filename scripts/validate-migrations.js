import fs from "node:fs";
import path from "node:path";
const dir = path.resolve("supabase/migrations");
const files = fs
  .readdirSync(dir)
  .filter((f) => /^\d+.*\.sql$/.test(f))
  .sort();
if (!files.length) throw new Error("No migrations found.");
const required = [
  "profiles",
  "admin_users",
  "admin_roles",
  "admin_permissions",
  "events",
  "event_sections",
  "ticket_inventory",
  "orders",
  "order_items",
  "payments",
  "manual_payment_submissions",
  "payment_webhook_events",
  "membership_applications",
  "memberships",
  "service_requests",
  "customer_support_requests",
  "notifications",
  "audit_logs",
  "payment_destinations",
  "payment_assignments",
  "payment_evidence_access_logs",
  "newsletter_subscribers",
  "admin_password_otps",
];
const sql = files
  .map((f) => fs.readFileSync(path.join(dir, f), "utf8"))
  .join("\n");
for (const table of required)
  if (!new RegExp(`create table (?:if not exists )?${table}\\b`).test(sql))
    throw new Error(`Missing table: ${table}`);
for (const forbidden of ["tickets", "qr_codes", "ticket_wallets", "check_ins"])
  if (new RegExp(`create table ${forbidden}`).test(sql))
    throw new Error(`Forbidden table: ${forbidden}`);
console.log(
  `Validated ${files.length} migrations and ${required.length} required tables.`,
);
