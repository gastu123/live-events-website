import "dotenv/config";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import request from "supertest";
import { createClient } from "@supabase/supabase-js";
import { createApp } from "../server/app.js";
import { loadConfig } from "../server/config.js";
import { createDatabase } from "../server/db.js";
import { createLogger } from "../server/logger.js";

const config = loadConfig();
const db = createDatabase(config.DATABASE_URL);
const app = createApp({ config, db, logger: createLogger("silent") });
const service = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const token = crypto.randomUUID();
const email = `lifecycle-${token}@example.com`;
const password = `${crypto.randomBytes(24).toString("base64url")}Aa1!`;
let userId;
let registrationVerified = false;

try {
  const registered = await request(app).post("/api/v1/auth/register").send({
    fullName: "Hosted Lifecycle Member",
    email,
    password,
  });
  if (registered.status === 201) {
    registrationVerified = true;
    const users = await service.auth.admin.listUsers({ page: 1, perPage: 1000 });
    userId = users.data.users.find((user) => user.email === email)?.id;
    assert.ok(userId, "Registration did not create the hosted Auth user.");
    const confirmed = await service.auth.admin.updateUserById(userId, { email_confirm: true });
    assert.equal(confirmed.error, null, "Unable to confirm temporary hosted user.");
  } else if (/rate limit/i.test(registered.body.error?.message || "")) {
    const created = await service.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: "Hosted Lifecycle Member" },
    });
    assert.equal(created.error, null, "Unable to create disposable hosted user after Auth rate limit.");
    userId = created.data.user.id;
    console.log("Hosted registration route was rate-limited by Supabase email delivery; continuing with an authorized disposable confirmed user.");
  } else {
    assert.equal(registered.status, 201, registered.body.error?.message);
  }

  const customer = request.agent(app);
  const login = await customer.post("/api/v1/auth/login").send({ email, password });
  assert.equal(login.status, 200, login.body.error?.message);
  const application = await customer.post("/api/v1/membership-applications")
    .set("X-CSRF-Token", login.body.data.csrfToken)
    .send({
      fullName: "Hosted Lifecycle Member",
      email,
      country: "NG",
      reason: "This uniquely tagged hosted lifecycle verification needs membership review.",
      interest: "general_membership",
    });
  assert.equal(application.status, 201, application.body.error?.message);
  assert.equal(application.body.data.status, "pending");

  const administrator = request.agent(app);
  const adminLogin = await administrator.post("/api/v1/auth/admin/login").send({
    email: config.INITIAL_SUPER_ADMIN_EMAIL,
    password: config.INITIAL_SUPER_ADMIN_PASSWORD,
  });
  assert.equal(adminLogin.status, 200, adminLogin.body.error?.message);
  const applications = await administrator.get("/api/v1/admin/membership-applications");
  assert.equal(applications.status, 200);
  assert.ok(applications.body.data.some((row) => row.id === application.body.data.id));
  const decision = await administrator
    .post(`/api/v1/admin/membership-applications/${application.body.data.id}/decision`)
    .set("X-CSRF-Token", adminLogin.body.data.csrfToken)
    .send({ decision: "approved", notes: "Hosted lifecycle verification." });
  assert.equal(decision.status, 200, decision.body.error?.message);
  assert.equal(decision.body.data.status, "approved");

  const account = await customer.get("/api/v1/account/membership-applications");
  assert.equal(account.status, 200);
  assert.equal(account.body.data[0]?.membership_status, "active");
  const notifications = await customer.get("/api/v1/account/notifications");
  assert.equal(notifications.status, 200);
  assert.ok(notifications.body.data.some((row) => row.kind === "membership_approved"));
  const logout = await customer.post("/api/v1/auth/logout").send({});
  assert.equal(logout.status, 200);
  const blocked = await customer.get("/api/v1/account/notifications");
  assert.equal(blocked.status, 401);
  console.log(`Hosted member lifecycle passed: ${registrationVerified ? "register, " : ""}login, pending application, real admin approval, membership, notification, and logout protection.`);
} finally {
  if (userId) {
    await db.query("delete from notifications where profile_id=$1", [userId]);
    await db.query("delete from memberships where profile_id=$1", [userId]);
    await db.query("delete from membership_applications where profile_id=$1", [userId]);
    await service.auth.admin.deleteUser(userId);
  }
  await db.close();
}
