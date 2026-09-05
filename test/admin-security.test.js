import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createApp } from "../server/app.js";
import { loadConfig } from "../server/config.js";
import { createBrevoMailer } from "../server/email/brevo.js";

const config = loadConfig({
  NODE_ENV: "test", PORT: "3000", PUBLIC_ORIGIN: "http://localhost:3000",
  ADMIN_ORIGIN: "http://admin.localhost:3000", DATABASE_URL: "postgres://test",
  SUPABASE_URL: "https://example.supabase.co", SUPABASE_ANON_KEY: "anon-test",
  SUPABASE_SERVICE_ROLE_KEY: "service-test", COOKIE_SECRET: "12345678901234567890123456789012",
});
const logger = { child() { return this; }, info() {}, error() {} };
function auth(superAdmin = true, permissions = ["admins.manage"]) {
  const middleware = (req, _res, next) => {
    req.user = { id: "10000000-0000-4000-8000-000000000099", email: "admin@example.com" };
    req.admin = { id: "10000000-0000-4000-8000-000000000001", is_super_admin: superAdmin, permissions };
    next();
  };
  return {
    anon: { auth: { signInWithPassword: async () => ({ data: {}, error: null }) } },
    service: { auth: { admin: {
      updateUserById: async () => ({ error: null }),
      signOut: async () => {},
      listUsers: async () => ({ data: { users: [{ id: "u1", email: "admin@example.com" }] }, error: null }),
    } } },
    requireUser: middleware, requireAdmin: () => middleware, validateAdminNetwork() {},
    setSession: () => "csrf", clearSession() {},
  };
}
const app = (db, authService = auth(), mailer = { enabled: false, sendAdminOtp: async () => {}, sendPasswordChanged: async () => {} }) =>
  createApp({ config, db, logger, services: { auth: authService, mailer } });

test("admin recovery OTP is hashed, single-use prepared, and can reset through a mocked Brevo delivery", async () => {
  let otpRow;
  let deliveredCode;
  let resetHash;
  const db = {
    query: async (sql, params = []) => {
      if (sql.includes("ip_count")) return { rows: [{ ip_count: "0" }] };
      if (sql.includes("account_count")) return { rows: [{ account_count: "0" }] };
      if (sql.startsWith("select id,coalesce")) return { rows: [{ id: "a1", destination_email: "recovery@example.com" }] };
      if (sql.startsWith("select resend_available_at")) return { rows: [] };
      if (sql.includes("insert into admin_password_otps")) {
        otpRow = { id: params[0], admin_user_id: params[1], otp_hash: params[2], attempts: 0, expires_at: new Date(Date.now() + 600000), recovery_email: "recovery@example.com" };
        return { rows: [] };
      }
      if (sql.includes("select o.id,o.otp_hash")) return { rows: otpRow ? [otpRow] : [] };
      if (sql.startsWith("update admin_password_otps set verified_at")) { resetHash = params[1]; return { rows: [] }; }
      if (sql.includes("select o.id,o.admin_user_id")) return { rows: resetHash ? [{ id: otpRow.id, admin_user_id: "a1", profile_id: "u1", recovery_email: "recovery@example.com" }] : [] };
      if (sql.startsWith("update admin_users set sessions_invalidated_at")) return { rows: [] };
      return { rows: [] };
    },
  };
  const mailer = { enabled: false, sendAdminOtp: async ({ otp }) => { deliveredCode = otp; }, sendPasswordChanged: async () => {} };
  const server = app(db, auth(), mailer);
  const sent = await request(server).post("/api/v1/auth/admin/recovery/request").send({ email: "admin@example.com" });
  assert.equal(sent.status, 202);
  assert.match(sent.body.data.maskedEmail, /\*/);
  assert.notEqual(otpRow.otp_hash, deliveredCode);
  const verified = await request(server).post("/api/v1/auth/admin/recovery/verify").send({ email: "admin@example.com", code: deliveredCode });
  assert.equal(verified.status, 200);
  assert.match(verified.body.data.maskedEmail, /\*/);
  assert.ok(verified.body.data.resetToken);
  const reset = await request(server).post("/api/v1/auth/admin/recovery/reset").send({ email: "admin@example.com", resetToken: verified.body.data.resetToken, newPassword: "SaferAdmin#2026", confirmPassword: "SaferAdmin#2026" });
  assert.equal(reset.status, 200);
  assert.equal(reset.body.data.sessionsRevoked, true);
});

test("Brevo adapter never calls the network when credentials are absent", async () => {
  let called = false;
  const mailer = createBrevoMailer(config, async () => { called = true; });
  const result = await mailer.sendAdminOtp({ to: "admin@example.com", otp: "123456", ttlMinutes: 10 });
  assert.equal(result.mocked, true);
  assert.equal(called, false);
});

test("an administrator cannot assign a role containing permissions they lack", async () => {
  const db = { query: async (sql) => {
    if (sql.startsWith("select is_super_admin")) return { rows: [{ is_super_admin: false }] };
    if (sql.startsWith("select name from admin_roles")) return { rows: [{ name: "Finance Manager" }] };
    if (sql.includes("admin_role_permissions")) return { rows: [{ code: "payments.verify" }] };
    return { rows: [] };
  } };
  const response = await request(app(db, auth(false, ["admins.manage"])))
    .patch("/api/v1/admin/admins/20000000-0000-4000-8000-000000000001/role")
    .send({ roleId: "30000000-0000-4000-8000-000000000001" });
  assert.equal(response.status, 403);
  assert.equal(response.body.error.code, "PERMISSION_ESCALATION_DENIED");
});

test("the protected Super Administrator role cannot be invited", async () => {
  const db = { query: async (sql) => {
    if (sql.startsWith("select id,name from admin_roles")) return { rows: [{ id: "30000000-0000-4000-8000-000000000001", name: "Super Administrator" }] };
    return { rows: [] };
  } };
  const response = await request(app(db)).post("/api/v1/admin/admins/invite").send({
    fullName: "Second Super Admin",
    email: "second-super@example.com",
    password: "Admin1234",
    confirmPassword: "Admin1234",
    roleId: "30000000-0000-4000-8000-000000000001",
  });
  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, "ROLE_INVALID");
});

test("the protected Super Administrator role cannot be assigned through role updates", async () => {
  const db = { query: async (sql) => {
    if (sql.startsWith("select is_super_admin")) return { rows: [{ is_super_admin: false }] };
    if (sql.startsWith("select name from admin_roles")) return { rows: [{ name: "Super Administrator" }] };
    return { rows: [] };
  } };
  const response = await request(app(db)).patch("/api/v1/admin/admins/20000000-0000-4000-8000-000000000001/role").send({ roleId: "30000000-0000-4000-8000-000000000001" });
  assert.equal(response.status, 409);
  assert.equal(response.body.error.code, "SUPER_ROLE_PROTECTED");
});

test("a super administrator may be demoted only when another active super administrator exists", async () => {
  const db = { query: async (sql) => {
    if (sql.startsWith("select is_super_admin")) return { rows: [{ is_super_admin: true }] };
    if (sql.startsWith("select name from admin_roles")) return { rows: [{ name: "Event Manager" }] };
    if (sql.startsWith("select count(*) count")) return { rows: [{ count: "1" }] };
    if (sql.startsWith("update admin_users set role_id")) return { rows: [{ id: "target", role_id: "role", status: "active" }] };
    return { rows: [] };
  } };
  const response = await request(app(db)).patch("/api/v1/admin/admins/20000000-0000-4000-8000-000000000001/role").send({ roleId: "30000000-0000-4000-8000-000000000001" });
  assert.equal(response.status, 200);
});
