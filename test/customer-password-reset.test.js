import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createApp } from "../server/app.js";
import { HttpError } from "../server/http.js";
import { loadConfig } from "../server/config.js";

const config = loadConfig({
  NODE_ENV: "test",
  PORT: "3000",
  PUBLIC_ORIGIN: "https://public.example",
  ADMIN_ORIGIN: "https://admin.example",
  DATABASE_URL: "postgres://test",
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_ANON_KEY: "anon-test",
  SUPABASE_SERVICE_ROLE_KEY: "service-test",
  COOKIE_SECRET: "12345678901234567890123456789012",
});
const logger = { child() { return this; }, info() {}, error() {} };
function resetAuth({ resetError = null } = {}) {
  let password = "OldCustomer123";
  let resetRequest;
  let updatedPassword;
  let recoverySession;
  const sessionUser = { id: "customer-id", email: "customer@example.com" };
  return {
    get resetRequest() { return resetRequest; },
    get updatedPassword() { return updatedPassword; },
    get recoverySession() { return recoverySession; },
    anon: { auth: {
      resetPasswordForEmail: async (_email, options) => { resetRequest = { email: "customer@example.com", options }; return { data: {}, error: resetError }; },
      signInWithPassword: async ({ email: _email, password: candidate }) => candidate === password
        ? { data: { user: sessionUser, session: { access_token: "login-access", refresh_token: "login-refresh", expires_in: 3600 } }, error: null }
        : { data: {}, error: new Error("invalid") },
      verifyOtp: async ({ token_hash }) => token_hash === "valid-token"
        ? { data: { session: { access_token: "recovery-access", refresh_token: "recovery-refresh", expires_in: 3600 } }, error: null }
        : { data: {}, error: new Error("invalid reset") },
    } },
    service: { auth: {
      getUser: async (token) => token === "recovery-access" || token === "login-access"
        ? { data: { user: sessionUser }, error: null }
        : { data: {}, error: new Error("invalid session") },
      admin: {
        updateUserById: async (_id, values) => { updatedPassword = values.password; password = values.password; return { error: null }; },
        signOut: async (token) => { recoverySession = token; return { error: null }; },
      },
    } },
    setSession(res, session, kind = "customer") {
      assert.equal(kind, "customer");
      res.cookie("customer_access_token", session.access_token, { httpOnly: true, path: "/" });
      res.cookie("customer_refresh_token", session.refresh_token, { httpOnly: true, path: "/" });
      res.cookie("customer_csrf", "customer-reset-csrf", { path: "/" });
      return "customer-reset-csrf";
    },
    clearSession(res, kind = "customer") {
      assert.equal(kind, "customer");
      for (const name of ["customer_access_token", "customer_refresh_token", "customer_csrf"]) res.clearCookie(name, { path: "/" });
    },
    requireUser(req, _res, next) {
      if (req.cookies.customer_access_token !== "recovery-access") return next(new HttpError(401, "AUTH_REQUIRED", "Authentication required."));
      req.user = sessionUser;
      next();
    },
    requireAdmin: () => (_req, _res, next) => next(new HttpError(401, "AUTH_REQUIRED", "Authentication required.")),
    validateAdminNetwork() {},
  };
}
const makeApp = (auth) => createApp({ config, db: { query: async () => ({ rows: [] }) }, logger, services: { auth, mailer: { enabled: false } } });

test("customer forgot-password uses the configured public recovery redirect", async () => {
  const auth = resetAuth();
  const response = await request(makeApp(auth)).post("/api/v1/auth/forgot-password").send({ email: "customer@example.com" });
  assert.equal(response.status, 200);
  assert.deepEqual(auth.resetRequest, { email: "customer@example.com", options: { redirectTo: "https://public.example/#account" } });
});

test("customer forgot-password reports provider failures without exposing provider details", async () => {
  const response = await request(makeApp(resetAuth({ resetError: new Error("provider unavailable") })))
    .post("/api/v1/auth/forgot-password")
    .send({ email: "customer@example.com" });
  assert.equal(response.status, 502);
  assert.equal(response.body.error.code, "PASSWORD_RESET_REQUEST_FAILED");
  assert.equal(response.body.error.message, "Password-reset instructions could not be requested right now. Please try again later.");
});

test("customer recovery session validates confirmation, updates password, and revokes the customer session", async () => {
  const auth = resetAuth();
  const agent = request.agent(makeApp(auth));
  const verified = await agent.post("/api/v1/auth/password-reset-session").send({ tokenHash: "valid-token" });
  assert.equal(verified.status, 200);
  const mismatch = await agent.post("/api/v1/auth/reset-password")
    .set("X-CSRF-Token", verified.body.data.csrfToken)
    .send({ password: "Customer1234", confirmPassword: "Different123" });
  assert.equal(mismatch.status, 400);
  assert.equal(mismatch.body.error.code, "PASSWORD_MISMATCH");
  const updated = await agent.post("/api/v1/auth/reset-password")
    .set("X-CSRF-Token", verified.body.data.csrfToken)
    .send({ password: "Customer1234", confirmPassword: "Customer1234" });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.data.sessionsRevoked, true);
  assert.equal(auth.updatedPassword, "Customer1234");
  assert.equal(auth.resetRequest, undefined);
  assert.equal(auth.recoverySession, "recovery-access");
  const login = await request(makeApp(auth)).post("/api/v1/auth/login").send({ email: "customer@example.com", password: "Customer1234" });
  assert.equal(login.status, 200);
  assert.deepEqual(login.headers["set-cookie"].map((cookie) => cookie.split("=")[0]).sort(), ["customer_access_token", "customer_csrf", "customer_refresh_token"].sort());
});

test("customer recovery accepts the Supabase access-token fragment and sets only customer cookies", async () => {
  const auth = resetAuth();
  const response = await request(makeApp(auth))
    .post("/api/v1/auth/password-reset-session")
    .send({ accessToken: "recovery-access", refreshToken: "recovery-refresh" });
  assert.equal(response.status, 200);
  assert.deepEqual(response.headers["set-cookie"].map((cookie) => cookie.split("=")[0]).sort(), ["customer_access_token", "customer_csrf", "customer_refresh_token"].sort());
});

test("invalid customer recovery links are rejected", async () => {
  const response = await request(makeApp(resetAuth())).post("/api/v1/auth/password-reset-session").send({ tokenHash: "expired-or-used-token" });
  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, "RESET_LINK_INVALID");
});
