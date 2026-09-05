import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createApp } from "../server/app.js";
import { loadConfig } from "../server/config.js";
import { HttpError } from "../server/http.js";

const config = loadConfig({
  NODE_ENV: "test",
  PORT: "3000",
  PUBLIC_ORIGIN: "http://localhost:3000",
  ADMIN_ORIGIN: "http://admin.localhost:3000",
  DATABASE_URL: "postgres://test",
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_ANON_KEY: "anon-test",
  SUPABASE_SERVICE_ROLE_KEY: "service-test",
  COOKIE_SECRET: "12345678901234567890123456789012",
});
const logger = { child() { return this; }, info() {}, error() {} };
const users = {
  "customer@example.com": { id: "customer-id", email: "customer@example.com", password: "Customer123" },
  "admin@example.com": { id: "admin-id", email: "admin@example.com", password: "Admin1234" },
};
function isolatedAuth() {
  const sessions = new Map();
  const signIn = async ({ email, password }) => {
    const user = users[email];
    if (!user || user.password !== password)
      return { data: {}, error: new Error("invalid") };
    const session = { access_token: `${user.id}-access`, refresh_token: `${user.id}-refresh`, expires_in: 3600 };
    sessions.set(session.access_token, user);
    return { data: { user, session }, error: null };
  };
  const middlewareUser = (req, _res, next) => {
    const user = sessions.get(req.cookies.customer_access_token);
    if (!user) return next(new HttpError(401, "AUTH_REQUIRED", "Authentication required."));
    req.user = user;
    next();
  };
  return {
    anon: { auth: { signInWithPassword: signIn } },
    service: {
      auth: {
        getUser: async (token) => ({ data: { user: sessions.get(token) || null }, error: sessions.has(token) ? null : new Error("invalid") }),
        admin: {
          signOut: async (token) => { sessions.delete(token); return { error: null }; },
          updateUserById: async () => ({ error: null }),
        },
      },
    },
    setSession(res, session, kind = "customer") {
      const prefix = kind === "admin" ? "admin_" : "customer_";
      res.cookie(`${prefix}access_token`, session.access_token, { httpOnly: true, path: "/" });
      res.cookie(`${prefix}refresh_token`, session.refresh_token, { httpOnly: true, path: "/" });
      res.cookie(`${prefix}csrf`, `${prefix}csrf-token`, { path: "/" });
      return `${prefix}csrf-token`;
    },
    clearSession(res, kind = "customer") {
      const prefix = kind === "admin" ? "admin_" : "customer_";
      for (const name of [`${prefix}access_token`, `${prefix}refresh_token`, `${prefix}csrf`]) res.clearCookie(name, { path: "/" });
    },
    requireUser: middlewareUser,
    requireAdmin: () => (req, _res, next) => {
      const user = sessions.get(req.cookies.admin_access_token);
      if (!user) return next(new HttpError(401, "AUTH_REQUIRED", "Authentication required."));
      req.user = user;
      req.admin = { id: "admin-record", is_super_admin: true, status: "active", permissions: [] };
      next();
    },
    validateAdminNetwork() {},
  };
}

const db = {
  query: async (sql, params = []) => {
    if (sql.startsWith("select id from admin_users where profile_id"))
      return { rows: params[0] === "admin-id" ? [{ id: "admin-record" }] : [] };
    if (sql.startsWith("select id, full_name, phone, country from profiles"))
      return { rows: [{ id: params[0], full_name: params[0] === "customer-id" ? "Customer User" : "Admin User", phone: null, country: null }] };
    if (sql.startsWith("select id, status from admin_users")) return { rows: [{ id: "admin-record", status: "active" }] };
    if (sql.startsWith("select id,code,description from admin_permissions")) return { rows: [{ id: "permission", code: "admins.manage", description: "Manage administrators" }] };
    return { rows: [] };
  },
};
const makeApp = () => createApp({ config, db, logger, services: { auth: isolatedAuth(), mailer: { enabled: false } } });

test("customer and Admin sessions remain isolated through login and logout", async () => {
  const app = makeApp();
  const customer = request.agent(app);
  const administrator = request.agent(app);
  const customerLogin = await customer.post("/api/v1/auth/login").send({ email: "customer@example.com", password: "Customer123" });
  assert.equal(customerLogin.status, 200);
  assert.deepEqual(customerLogin.headers["set-cookie"].map((cookie) => cookie.split("=")[0]).sort(), ["customer_access_token", "customer_csrf", "customer_refresh_token"].sort());
  const customerMe = await customer.get("/api/v1/auth/me");
  assert.equal(customerMe.status, 200);
  assert.equal(customerMe.body.data.full_name, "Customer User");

  const adminLogin = await administrator.post("/api/v1/auth/admin/login").send({ email: "admin@example.com", password: "Admin1234" });
  assert.equal(adminLogin.status, 200);
  assert.deepEqual(adminLogin.headers["set-cookie"].map((cookie) => cookie.split("=")[0]).sort(), ["admin_access_token", "admin_csrf", "admin_refresh_token"].sort());
  assert.equal((await administrator.get("/api/v1/admin/permissions")).status, 200);
  assert.equal((await customer.get("/api/v1/auth/me")).status, 200);

  assert.equal((await customer.post("/api/v1/auth/logout").send({})).status, 200);
  assert.equal((await customer.get("/api/v1/auth/me")).status, 401);
  assert.equal((await administrator.get("/api/v1/admin/permissions")).status, 200);

  assert.equal((await administrator.post("/api/v1/auth/admin/logout").send({})).status, 200);
  assert.equal((await administrator.get("/api/v1/admin/permissions")).status, 401);
  assert.equal((await customer.get("/api/v1/auth/me")).status, 401);
});

test("Admin credentials cannot create a public customer session", async () => {
  const app = makeApp();
  const publicSession = request.agent(app);
  const login = await publicSession.post("/api/v1/auth/login").send({ email: "admin@example.com", password: "Admin1234" });
  assert.equal(login.status, 401);
  assert.equal((await publicSession.get("/api/v1/auth/me")).status, 401);
  assert.equal((await publicSession.get("/api/v1/admin/permissions")).status, 401);
});
