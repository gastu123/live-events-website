import "dotenv/config";
import crypto from "node:crypto";
import pg from "pg";
import { createClient } from "@supabase/supabase-js";
import { loadConfig } from "../server/config.js";

const config = loadConfig();
const email = config.INITIAL_SUPER_ADMIN_EMAIL.toLowerCase();
const originalPassword = config.INITIAL_SUPER_ADMIN_PASSWORD;
const temporaryPassword = `${crypto.randomBytes(24).toString("base64url")}aA1!`;
const supabase = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
let user;
for (let page = 1; page <= 20 && !user; page += 1) {
  const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 100 });
  if (error) throw new Error("Supabase Auth administrator lookup failed.");
  user = data.users.find((candidate) => candidate.email?.toLowerCase() === email);
  if (data.users.length < 100) break;
}
if (!user) throw new Error("The intended initial Super Administrator does not exist in Supabase Auth.");

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
let temporaryPasswordActive = false;
const endpoint = (path) => `${process.env.VERIFY_ORIGIN || config.PUBLIC_ORIGIN}/api/v1${path}`;
const cookieHeader = (response) => response.headers.getSetCookie().map((value) => value.split(";", 1)[0]).join("; ");
async function login(password) {
  const response = await fetch(endpoint("/auth/admin/login"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const payload = await response.json().catch(() => ({}));
  return { response, payload, cookies: cookieHeader(response) };
}
async function changePassword(session, currentPassword, newPassword) {
  return fetch(endpoint("/auth/admin/change-password"), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: session.cookies,
      "x-csrf-token": session.payload.data.csrfToken,
    },
    body: JSON.stringify({ currentPassword, newPassword, confirmPassword: newPassword }),
  });
}

try {
  const result = await pool.query(
    `select a.id,a.status,a.is_super_admin,a.recovery_email,r.name role,count(p.id)::int permission_count
     from admin_users a join admin_roles r on r.id=a.role_id
     left join admin_role_permissions rp on rp.role_id=r.id
     left join admin_permissions p on p.id=rp.permission_id
     where a.profile_id=$1 and a.deleted_at is null group by a.id,r.name`,
    [user.id],
  );
  const administrator = result.rows[0];
  if (!administrator || administrator.status !== "active" || !administrator.is_super_admin || administrator.role !== "Super Administrator")
    throw new Error("The intended account is not an active Super Administrator in PostgreSQL.");
  if (administrator.recovery_email?.toLowerCase() !== email)
    throw new Error("The Super Administrator recovery email is not configured correctly.");
  if (administrator.permission_count < 1) throw new Error("The Super Administrator role has no permissions.");

  const rejected = await login(`${crypto.randomBytes(24).toString("base64url")}zZ9!`);
  if (rejected.response.status !== 401) throw new Error("Incorrect-password rejection failed.");

  let session = await login(originalPassword);
  if (session.response.status !== 200) throw new Error(`Administrator login failed with HTTP ${session.response.status}.`);
  const access = await fetch(endpoint("/admin/permissions"), { headers: { cookie: session.cookies } });
  if (access.status !== 200) throw new Error("Protected administrator permission access failed.");

  const refresh = await fetch(endpoint("/auth/admin/refresh"), { method: "POST", headers: { cookie: session.cookies } });
  if (refresh.status !== 200 || !cookieHeader(refresh)) throw new Error("Administrator session refresh failed.");

  const logout = await fetch(endpoint("/auth/admin/logout"), { method: "POST", headers: { cookie: session.cookies } });
  if (logout.status !== 200) throw new Error("Administrator logout failed.");
  const loggedOutAccess = await fetch(endpoint("/admin/permissions"), { headers: { cookie: session.cookies } });
  if (loggedOutAccess.status !== 401) throw new Error("Logged-out session remained usable.");

  session = await login(originalPassword);
  if (session.response.status !== 200) throw new Error("Administrator re-login failed.");
  const changed = await changePassword(session, originalPassword, temporaryPassword);
  if (changed.status !== 200) throw new Error(`Administrator password change failed with HTTP ${changed.status}.`);
  temporaryPasswordActive = true;
  const expiredAccess = await fetch(endpoint("/admin/permissions"), { headers: { cookie: session.cookies } });
  if (expiredAccess.status !== 401) throw new Error("Revoked session remained usable after password change.");

  const temporarySession = await login(temporaryPassword);
  if (temporarySession.response.status !== 200) throw new Error("Immediate login with the changed password failed.");
  const restored = await changePassword(temporarySession, temporaryPassword, originalPassword);
  if (restored.status !== 200) throw new Error(`Original password restoration failed with HTTP ${restored.status}.`);
  temporaryPasswordActive = false;
  const finalSession = await login(originalPassword);
  if (finalSession.response.status !== 200) throw new Error("Final administrator re-login failed.");
  await fetch(endpoint("/auth/admin/logout"), { method: "POST", headers: { cookie: finalSession.cookies } });

  const audits = await pool.query(
    "select count(*)::int count from audit_logs where admin_user_id=$1 and action='admin.password_changed'",
    [administrator.id],
  );
  if (audits.rows[0].count < 2) throw new Error("Password-change audit records were not created.");
  console.log(`Verified complete hosted Super Administrator authentication lifecycle for ${email}.`);
} finally {
  if (temporaryPasswordActive && user)
    await supabase.auth.admin.updateUserById(user.id, { password: originalPassword });
  await pool.end();
}
