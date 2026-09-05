import "dotenv/config";
import crypto from "node:crypto";
import pg from "pg";
import { createClient } from "@supabase/supabase-js";

const origin = process.env.PUBLIC_ORIGIN || "http://localhost:3000";
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } },
);
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const email = `smoke-${crypto.randomUUID()}@example.invalid`;
const password = `${crypto.randomBytes(24).toString("base64url")}Aa1!`;
let userId;

async function removeSmokeUser(profileId) {
  const admins = await pool.query(
    "select id from admin_users where profile_id=$1 and is_super_admin=false",
    [profileId],
  );
  for (const admin of admins.rows) {
    await pool.query("delete from admin_password_otps where admin_user_id=$1", [admin.id]);
    await pool.query("delete from admin_login_attempts where admin_user_id=$1", [admin.id]);
    await pool.query("delete from notifications where admin_user_id=$1", [admin.id]);
    await pool.query("delete from audit_logs where admin_user_id=$1", [admin.id]);
    await pool.query("delete from admin_users where id=$1", [admin.id]);
  }
  await supabase.auth.admin.deleteUser(profileId);
}

const assertStatus = (response, expected, label) => {
  if (response.status !== expected)
    throw new Error(`${label} returned HTTP ${response.status}`);
};

try {
  const stale = await pool.query(
    "select id from profiles where full_name='Hosted Smoke Test'",
  );
  for (const profile of stale.rows) await removeSmokeUser(profile.id);

  const [publicPage, adminPage, health, events] = await Promise.all([
    fetch(`${origin}/`),
    fetch(`${origin}/admin.html`),
    fetch(`${origin}/api/v1/health`),
    fetch(`${origin}/api/v1/events`),
  ]);
  assertStatus(publicPage, 200, "Public page");
  assertStatus(adminPage, 200, "Admin page");
  assertStatus(health, 200, "Health API");
  assertStatus(events, 200, "Events API");
  if (!String(adminPage.headers.get("x-robots-tag")).includes("noindex"))
    throw new Error("Admin page is missing the noindex response header");

  const created = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: "Hosted Smoke Test" },
  });
  if (created.error || !created.data.user)
    throw created.error || new Error("Temporary Auth user was not created");
  userId = created.data.user.id;
  const role = await pool.query(
    "select id from admin_roles where name='Event Manager'",
  );
  if (!role.rows[0]) throw new Error("Seeded Event Manager role was not found");
  await pool.query(
    "insert into admin_users(profile_id,role_id,status,two_factor_required) values($1,$2,'active',false)",
    [userId, role.rows[0].id],
  );

  const login = await fetch(`${origin}/api/v1/auth/admin/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  assertStatus(login, 200, "Admin login");
  const cookies = login.headers
    .getSetCookie()
    .map((value) => value.split(";", 1)[0])
    .join("; ");
  const [me, overview] = await Promise.all([
    fetch(`${origin}/api/v1/auth/me`, { headers: { cookie: cookies } }),
    fetch(`${origin}/api/v1/admin/overview`, { headers: { cookie: cookies } }),
  ]);
  assertStatus(me, 200, "Current-user API");
  assertStatus(overview, 200, "Protected admin overview");
  console.log(
    "Hosted smoke test passed: pages, health, seeded events, Supabase Auth, customer session, admin authorization and database APIs.",
  );
} finally {
  if (userId) await removeSmokeUser(userId);
  await pool.end();
}
