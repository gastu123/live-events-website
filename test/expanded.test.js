import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import request from "supertest";
import { createApp } from "../server/app.js";
import { loadConfig } from "../server/config.js";
import { createPayPalAdapter } from "../server/payments/paypal.js";
import { createPaystackAdapter } from "../server/payments/paystack.js";
import { applyVerifiedPayment } from "../server/routes/webhooks.js";

const env = {
  NODE_ENV: "test",
  PORT: "3000",
  PUBLIC_ORIGIN: "http://localhost:3000",
  ADMIN_ORIGIN: "http://admin.localhost:3000",
  DATABASE_URL: "postgres://test",
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_ANON_KEY: "anon-test",
  SUPABASE_SERVICE_ROLE_KEY: "service-test",
  COOKIE_SECRET: "12345678901234567890123456789012",
  GIFT_CARD_PAYMENTS_ENABLED: "false",
  CARD_PROVIDER: "disabled",
  CARD_PROVIDER_SECRET_KEY: "",
  CARD_PROVIDER_WEBHOOK_SECRET: "",
};
const config = loadConfig(env);
const logger = {
  child() {
    return this;
  },
  info() {},
  error() {},
};

test("development rejects missing hosted backend configuration and demo mode", () => {
  assert.throws(() => loadConfig({ NODE_ENV: "development" }), /PUBLIC_ORIGIN.*DATABASE_URL/);
  assert.throws(
    () => loadConfig({ ...env, DEVELOPMENT_DEMO: "true" }),
    /Development demo mode is disabled/,
  );
});

test("production still rejects all missing secrets", () => {
  assert.throws(
    () => loadConfig({ NODE_ENV: "production" }),
    /PUBLIC_ORIGIN.*ADMIN_ORIGIN.*DATABASE_URL.*SUPABASE_URL.*COOKIE_SECRET/,
  );
});
const jsonResponse = (body, ok = true) => ({
  ok,
  status: ok ? 200 : 400,
  json: async () => body,
});
function fakeAuth({
  admin = true,
  permissions = true,
  superAdmin = true,
} = {}) {
  const middleware = (req, _res, next) => {
    req.user = {
      id: "10000000-0000-4000-8000-000000000099",
      email: "user@example.com",
    };
    next();
  };
  return {
    anon: {
      auth: {
        signUp: async () => ({
          data: { user: { id: "u1" }, session: null },
          error: null,
        }),
        signInWithPassword: async () => ({
          data: {
            user: { id: "u1", email: "user@example.com" },
            session: {
              access_token: "access",
              refresh_token: "refresh",
              expires_in: 3600,
            },
          },
          error: null,
        }),
        resetPasswordForEmail: async () => ({ error: null }),
        refreshSession: async () => ({
          data: {
            session: { access_token: "access", refresh_token: "refresh" },
          },
          error: null,
        }),
        verifyOtp: async () => ({
          data: {
            session: { access_token: "access", refresh_token: "refresh" },
          },
          error: null,
        }),
      },
    },
    service: {
      auth: {
        getUser: async () => ({
          data: { user: { id: "10000000-0000-4000-8000-000000000099" } },
        }),
        admin: {
          signOut: async () => {},
          updateUserById: async () => ({ error: null }),
          inviteUserByEmail: async () => ({
            data: { user: { id: "10000000-0000-4000-8000-000000000098" } },
            error: null,
          }),
        },
      },
      storage: {
        from: () => ({
          createSignedUploadUrl: async (path) => ({
            data: {
              token: "upload-token",
              signedUrl: `https://storage.example/${path}`,
            },
            error: null,
          }),
          createSignedUrl: async (path) => ({
            data: { signedUrl: `https://storage.example/${path}` },
            error: null,
          }),
        }),
      },
    },
    setSession: () => "csrf-token",
    clearSession: () => {},
    validateAdminNetwork: () => {},
    requireUser: middleware,
    requireAdmin: () =>
      admin && permissions
        ? (req, _res, next) => {
            req.user = { id: "u1" };
            req.admin = {
              id: "a1",
              is_super_admin: superAdmin,
              permissions: [],
            };
            next();
          }
        : (_req, _res, next) => {
            const error = new Error("Forbidden");
            error.status = 403;
            error.code = "FORBIDDEN";
            next(error);
          },
  };
}
const providers = {
  paypal: {
    create: async () => ({ id: "PAYPAL1", links: [] }),
    verifyWebhook: async () => true,
    verifyCapture: async () => ({}),
  },
  card: {
    create: async () => ({}),
    verifySignature: () => true,
    verifyTransaction: async () => ({}),
  },
};
const makeApp = (db, auth = fakeAuth()) =>
  createApp({ config, db, logger, services: { auth, ...providers } });

test("customer registration prepares email verification", async () => {
  const db = { query: async () => ({ rows: [] }), transaction: async () => {} };
  const r = await request(makeApp(db)).post("/api/v1/auth/register").send({
    fullName: "Test User",
    email: "user@example.com",
    password: "password123",
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.data.emailVerificationRequired, true);
});
test("customer login returns CSRF without exposing provider tokens", async () => {
  const db = { query: async () => ({ rows: [] }) };
  const r = await request(makeApp(db))
    .post("/api/v1/auth/login")
    .send({ email: "user@example.com", password: "password123" });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.csrfToken, "csrf-token");
  assert.equal(r.body.data.access_token, undefined);
});
test("admin login records a successful attempt", async () => {
  const sql = [];
  const db = {
    query: async (text) => {
      sql.push(text);
      if (text.includes("select id, status"))
        return { rows: [{ id: "a1", status: "active" }] };
      return { rows: [] };
    },
  };
  const r = await request(makeApp(db))
    .post("/api/v1/auth/admin/login")
    .send({ email: "admin@example.com", password: "password123" });
  assert.equal(r.status, 200);
  assert.ok(sql.some((text) => text.includes("admin_login_attempts")));
  assert.ok(sql.some((text) => text.includes("audit_logs")));
});
test("admin-created events are published so the public site can list them", async () => {
  const db = {
    query: async (text, params) => {
      if (text.startsWith("insert into events"))
        return {
          rows: [{
            id: "e1",
            title: params[0],
            slug: params[1],
            description: params[2],
            venue: params[3],
            city: params[4],
            country: params[5],
            starts_at: params[6],
            currency: params[7],
            status: "published",
            created_by: params[8],
          }],
        };
      if (text.includes("insert into audit_logs")) return { rows: [] };
      return { rows: [] };
    },
  };
  const r = await request(makeApp(db))
    .post("/api/v1/admin/events")
    .send({
      title: "Launch Night",
      venue: "Grand Hall",
      city: "Lagos",
      country: "NG",
      startsAt: "2027-02-20T19:30:00.000Z",
      currency: "USD",
      description: "A test event",
    });
  assert.equal(r.status, 201);
  assert.equal(r.body.data.status, "published");
});
test("role middleware denies protected admin operations", async () => {
  const db = { query: async () => ({ rows: [] }) };
  const r = await request(makeApp(db, fakeAuth({ permissions: false }))).get(
    "/api/v1/admin/events",
  );
  assert.equal(r.status, 403);
  assert.equal(r.body.error.code, "FORBIDDEN");
});
test("Super Administrator cannot be deleted through the API", async () => {
  const db = {
    query: async (text) => {
      if (text.startsWith("select is_super_admin")) return { rows: [{ is_super_admin: true }] };
      if (text.startsWith("select count(*) count")) return { rows: [{ count: "0" }] };
      return { rows: [] };
    },
  };
  const r = await request(makeApp(db))
    .delete("/api/v1/admin/admins/10000000-0000-4000-8000-000000000001")
    .send({});
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, "SUPER_ADMIN_PROTECTED");
});
test("Super Administrator cannot be demoted through the API", async () => {
  const db = {
    query: async (text) =>
      text.startsWith("select is_super_admin")
        ? { rows: [{ is_super_admin: true }] }
        : text.startsWith("select name from admin_roles")
          ? { rows: [{ name: "Event Manager" }] }
        : text.startsWith("select count(*) count")
          ? { rows: [{ count: "0" }] }
        : { rows: [] },
  };
  const r = await request(makeApp(db))
    .patch("/api/v1/admin/admins/10000000-0000-4000-8000-000000000001/role")
    .send({ roleId: "20000000-0000-4000-8000-000000000001" });
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, "SUPER_ADMIN_PROTECTED");
});
test("public event listing returns database events", async () => {
  const rows = [{ id: "e1", slug: "event", title: "Event" }];
  const db = { query: async () => ({ rows }) };
  const r = await request(makeApp(db)).get("/api/v1/events");
  assert.equal(r.status, 200);
  assert.equal(r.body.data[0].slug, "event");
});
test("public event detail returns server sections", async () => {
  let calls = 0;
  const db = {
    query: async () => ({
      rows:
        ++calls === 1
          ? [{ id: "e1", slug: "event", title: "Event" }]
          : [{ id: "s1", price_minor: 5000, available_quantity: 4 }],
    }),
  };
  const r = await request(makeApp(db)).get("/api/v1/events/event");
  assert.equal(r.status, 200);
  assert.equal(r.body.data.sections[0].price_minor, 5000);
});
test("admin event creation writes an audit log", async () => {
  const statements = [];
  const db = {
    query: async (text) => {
      statements.push(text);
      if (text.startsWith("insert into events"))
        return {
          rows: [
            { id: "10000000-0000-4000-8000-000000000001", title: "New Event" },
          ],
        };
      return { rows: [] };
    },
  };
  const r = await request(makeApp(db)).post("/api/v1/admin/events").send({
    title: "New Event",
    description: "",
    venue: "Arena",
    city: "Lagos",
    country: "NG",
    startsAt: "2027-01-01T18:00:00.000Z",
    currency: "USD",
  });
  assert.equal(r.status, 201);
  assert.ok(statements.some((text) => text.includes("audit_logs")));
});
test("Paystack signature uses constant-time HMAC verification", () => {
  const secret = "key";
  const adapter = createPaystackAdapter({
    ...config,
    PAYSTACK_ENABLED: true,
    PAYSTACK_SECRET_KEY: "key",
    CARD_PROVIDER_SECRET_KEY: "key",
    CARD_PROVIDER_WEBHOOK_SECRET: secret,
  });
  const raw = Buffer.from('{"event":"charge.success"}');
  const signature = crypto
    .createHmac("sha512", secret)
    .update(raw)
    .digest("hex");
  assert.equal(adapter.verifySignature(raw, signature), true);
  assert.equal(adapter.verifySignature(raw, "0".repeat(128)), false);
});
test("Paystack verify calls provider API and normalizes money", async () => {
  const adapter = createPaystackAdapter(
    { ...config, PAYSTACK_ENABLED: true, PAYSTACK_SECRET_KEY: "key" },
    async () =>
      jsonResponse({
        status: true,
        data: {
          status: "success",
          id: 77,
          reference: "ORD-1",
          amount: 12500,
          currency: "USD",
          metadata: { order_reference: "ORD-1" },
        },
      }),
  );
  const result = await adapter.verifyTransaction("ORD-1");
  assert.deepEqual(result, {
    successful: true,
    providerReference: "77",
    lookupReference: "ORD-1",
    orderReference: "ORD-1",
    amountMinor: 12500,
    currency: "USD",
  });
});
test("PayPal webhook signature is checked through PayPal API", async () => {
  let calls = 0;
  const adapter = createPayPalAdapter(
    {
      ...config,
      PAYPAL_ENABLED: true,
      PAYPAL_CLIENT_ID: "id",
      PAYPAL_CLIENT_SECRET: "secret",
      PAYPAL_WEBHOOK_ID: "hook",
    },
    async () =>
      ++calls === 1
        ? jsonResponse({ access_token: "token" })
        : jsonResponse({ verification_status: "SUCCESS" }),
  );
  assert.equal(
    await adapter.verifyWebhook(
      {
        "paypal-auth-algo": "SHA256",
        "paypal-cert-url": "https://example.com/cert",
        "paypal-transmission-id": "id",
        "paypal-transmission-sig": "sig",
        "paypal-transmission-time": "now",
      },
      { id: "event" },
    ),
    true,
  );
});
test("PayPal renews an expired OAuth token and retries once", async () => {
  const calls = [];
  const adapter = createPayPalAdapter(
    {
      ...config,
      PAYPAL_ENABLED: true,
      PAYPAL_CLIENT_ID: "id",
      PAYPAL_CLIENT_SECRET: "secret",
      PAYPAL_WEBHOOK_ID: "hook",
    },
    async (url) => {
      calls.push(url);
      if (url.endsWith("/oauth2/token"))
        return {
          ok: true,
          status: 200,
          json: async () => ({
            access_token: `token-${calls.length}`,
            expires_in: 3600,
          }),
        };
      if (calls.filter((value) => value.includes("/captures/")).length === 1)
        return { ok: false, status: 401, json: async () => ({}) };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: "CAP-1",
          status: "COMPLETED",
          amount: { value: "10.00", currency_code: "USD" },
          custom_id: "ORD-1",
        }),
      };
    },
  );
  const verified = await adapter.verifyCapture("CAP-1");
  assert.equal(verified.successful, true);
  assert.equal(
    calls.filter((value) => value.endsWith("/oauth2/token")).length,
    2,
  );
});
test("PayPal creates and captures only through hosted server APIs", async () => {
  const requests = [];
  const adapter = createPayPalAdapter(
    {
      ...config,
      PAYPAL_ENABLED: true,
      PAYPAL_CLIENT_ID: "id",
      PAYPAL_CLIENT_SECRET: "secret",
      PAYPAL_WEBHOOK_ID: "hook",
    },
    async (url, options = {}) => {
      requests.push({ url, options });
      if (url.endsWith("/oauth2/token"))
        return {
          ok: true,
          status: 200,
          json: async () => ({ access_token: "token", expires_in: 3600 }),
        };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: "PROVIDER-ID",
          links: [
            { rel: "approve", href: "https://sandbox.paypal.com/approve" },
          ],
        }),
      };
    },
  );
  await adapter.create({
    orderReference: "ORD-9",
    amountMinor: 1234,
    currency: "USD",
    idempotencyKey: "idem-9",
    returnUrl: "https://example.com/return",
    cancelUrl: "https://example.com/cancel",
  });
  await adapter.captureOrder("PAYPAL-9", "capture-9");
  const createBody = JSON.parse(
    requests.find((entry) => entry.url.endsWith("/checkout/orders")).options
      .body,
  );
  assert.equal(createBody.purchase_units[0].custom_id, "ORD-9");
  assert.equal(createBody.purchase_units[0].amount.value, "12.34");
  assert.ok(requests.some((entry) => entry.url.endsWith("/PAYPAL-9/capture")));
});
test("Paystack initialization uses a unique provider reference and internal metadata", async () => {
  let requestBody;
  const adapter = createPaystackAdapter(
    { ...config, PAYSTACK_ENABLED: true, PAYSTACK_SECRET_KEY: "test-secret" },
    async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return jsonResponse({
        status: true,
        data: {
          authorization_url: "https://checkout.example",
          reference: requestBody.reference,
        },
      });
    },
  );
  await adapter.create({
    orderReference: "ORD-123",
    amountMinor: 5000,
    currency: "USD",
    email: "test@example.com",
    callbackUrl: "https://example.com/callback",
  });
  assert.match(requestBody.reference, /^PST-[a-f0-9]{20}$/);
  assert.equal(requestBody.metadata.order_reference, "ORD-123");
  assert.equal(requestBody.amount, 5000);
});
test("payment providers remain disabled without explicit enable flags", async () => {
  await assert.rejects(
    () => createPayPalAdapter(config).create({}),
    (error) => error.code === "PAYPAL_NOT_CONFIGURED",
  );
  await assert.rejects(
    () => createPaystackAdapter(config).create({}),
    (error) => error.code === "CARD_PROVIDER_NOT_CONFIGURED",
  );
});
test("automatic payment endpoints are not exposed and manual methods stay available", async () => {
  const db = { query: async () => ({ rows: [] }) };
  const app = makeApp(db);
  const [configuration, paypalCapture, paypalWebhook, cardWebhook] =
    await Promise.all([
      request(app).get("/api/v1/config"),
      request(app).post("/api/v1/payments/paypal/capture").send({}),
      request(app).post("/api/v1/webhooks/paypal").send({}),
      request(app).post("/api/v1/webhooks/card").send({}),
    ]);
  assert.deepEqual(configuration.body.data.payments, {
    paypal: true,
    cash_app: true,
    chime: true,
    bank_transfer: true,
    gift_card: true,
  });
  assert.equal(paypalCapture.status, 404);
  assert.equal(paypalWebhook.status, 404);
  assert.equal(cardWebhook.status, 404);
});
test("only a Super Administrator can verify a payment destination", async () => {
  const db = { query: async () => ({ rows: [] }) };
  const response = await request(makeApp(db, fakeAuth({ superAdmin: false })))
    .post(
      "/api/v1/admin/payment-destinations/10000000-0000-4000-8000-000000000001/verify",
    )
    .send({ enabled: true });
  assert.equal(response.status, 403);
  assert.equal(response.body.error.code, "SUPER_ADMIN_REQUIRED");
});
test("expired manual instructions are never revealed to a customer", async () => {
  const statements = [];
  const db = {
    query: async (text) => {
      statements.push(text);
      return { rows: [] };
    },
  };
  const response = await request(makeApp(db)).get(
    "/api/v1/account/payments/p1/instructions",
  );
  assert.equal(response.status, 404);
  assert.ok(
    statements.some((text) => text.includes("expire_payment_assignments")),
  );
});
test("customer notification feed is restricted to the authenticated profile", async () => {
  const calls = [];
  const db = {
    query: async (text, params) => {
      calls.push({ text, params });
      return { rows: [] };
    },
  };
  const response = await request(makeApp(db)).get(
    "/api/v1/account/notifications",
  );
  assert.equal(response.status, 200);
  assert.deepEqual(calls[0].params, [
    "10000000-0000-4000-8000-000000000099",
  ]);
  assert.match(calls[0].text, /where profile_id=\$1/);
});
test("administrator can assign transaction-specific owner-only payment details", async () => {
  const statements = [];
  const db = {
    query: async () => ({ rows: [] }),
    transaction: async (work) =>
      work({
        query: async (text) => {
          statements.push(text);
          if (text.startsWith("select p.*"))
            return {
              rows: [
                {
                  id: "p1",
                  order_id: "o1",
                  provider: "manual",
                  method: "cash_app",
                  status: "awaiting_payment_details",
                  amount_minor: 1000,
                  currency: "USD",
                },
              ],
            };
          if (text.startsWith("insert into payment_assignments"))
            return {
              rows: [
                {
                  id: "30000000-0000-4000-8000-000000000001",
                  status: "active",
                },
              ],
            };
          return { rows: [] };
        },
      }),
  };
  const response = await request(makeApp(db))
    .post(
      "/api/v1/admin/payments/10000000-0000-4000-8000-000000000001/assign-details",
    )
    .send({
      paymentMethod: "cash_app",
      accountName: "Example Events LLC",
      paymentIdentifier: "$ExampleEvents",
      amountMinor: 1000,
      currency: "USD",
      instructions: "Include the complete reference.",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });
  assert.equal(response.status, 201);
  assert.ok(
    statements.some((text) => text.includes("notifications(profile_id")),
  );
  assert.ok(statements.some((text) => text.includes("audit_logs")));
});
for (const [label, offset] of [
  ["under 15 minutes", 14 * 60 * 1000],
  ["over 7 days", 7 * 24 * 60 * 60 * 1000 + 1000],
])
  test(`payment assignment rejects expiry ${label}`, async () => {
    const response = await request(makeApp({ query: async () => ({ rows: [] }) }))
      .post(
        "/api/v1/admin/payments/10000000-0000-4000-8000-000000000001/assign-details",
      )
      .send({
        paymentMethod: "cash_app",
        accountName: "Example Events LLC",
        paymentIdentifier: "$ExampleEvents",
        amountMinor: 1000,
        currency: "USD",
        expiresAt: new Date(Date.now() + offset).toISOString(),
      });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "PAYMENT_DETAILS_INVALID");
  });
for (const details of [
  { method: "paypal", paymentIdentifier: "billing@example.com" },
  { method: "cash_app", paymentIdentifier: "$ExampleEvents" },
  { method: "chime", paymentIdentifier: "chime@example.com" },
  { method: "bank_transfer", bankName: "Example Bank", accountName: "Example Events LLC", accountNumber: "1234567890" },
  { method: "gift_card" },
])
  test(`${details.method} accepts only its receiving details`, async () => {
    const db = {
      query: async () => ({ rows: [] }),
      transaction: async (work) =>
        work({
          query: async (text) => {
            if (text.startsWith("select p.*"))
              return {
                rows: [{
                  id: "p1",
                  order_id: "o1",
                  order_reference: "ORD-1",
                  provider: "manual",
                  method: details.method,
                  status: "awaiting_payment_details",
                  amount_minor: 1000,
                  currency: "USD",
                }],
              };
            if (text.startsWith("insert into payment_assignments"))
              return { rows: [{ id: "a1", status: "active" }] };
            return { rows: [] };
          },
        }),
    };
    const response = await request(makeApp(db))
      .post("/api/v1/admin/payments/10000000-0000-4000-8000-000000000001/assign-details")
      .send({
        paymentMethod: details.method,
        ...details,
        amountMinor: 1000,
        currency: "USD",
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      });
    assert.equal(response.status, 201);
  });
test("clean evidence access is logged before a signed URL is returned", async () => {
  const statements = [];
  const db = {
    query: async (text) => {
      statements.push(text);
      if (text.startsWith("select id,evidence_storage_path"))
        return {
          rows: [
            {
              id: "s1",
              evidence_storage_path: "private/proof.png",
              evidence_scan_status: "clean",
            },
          ],
        };
      return { rows: [] };
    },
  };
  const response = await request(makeApp(db)).get(
    "/api/v1/admin/payments/p1/evidence",
  );
  assert.equal(response.status, 200);
  assert.ok(
    statements.some((text) => text.includes("payment_evidence_access_logs")),
  );
  assert.ok(statements.some((text) => text.includes("audit_logs")));
});
test("duplicate manual evidence records return a safe conflict", async () => {
  const duplicate = new Error("duplicate detail must not escape");
  duplicate.code = "23505";
  const db = {
    query: async () => ({ rows: [] }),
    transaction: async (work) =>
      work({
        query: async (text) => {
          if (text.startsWith("select p.id"))
            return {
              rows: [
                {
                  id: "p1",
                  order_id: "o1",
                  provider: "manual",
                  method: "cash_app",
                  status: "payment_details_ready",
                  assignment_id: "a1",
                },
              ],
            };
          if (text.startsWith("insert into manual_payment_submissions"))
            throw duplicate;
          return { rows: [] };
        },
      }),
  };
  const response = await request(makeApp(db))
    .post("/api/v1/account/payments/p1/manual-submission")
    .send({
      evidenceStoragePath: "10000000-0000-4000-8000-000000000099/p1/proof.png",
    });
  assert.equal(response.status, 409);
  assert.equal(response.body.error.code, "DUPLICATE_RECORD");
  assert.doesNotMatch(response.body.error.message, /detail must not escape/);
});
test("gift card code-only proof reaches pending verification without image scanning", async () => {
  const statements = [];
  const db = {
    query: async () => ({ rows: [] }),
    transaction: async (work) =>
      work({
        query: async (text) => {
          statements.push(text);
          if (text.startsWith("select p.id"))
            return {
              rows: [{
                id: "p1",
                order_id: "o1",
                provider: "manual",
                method: "gift_card",
                status: "payment_details_ready",
                assignment_id: "a1",
              }],
            };
          if (text.startsWith("insert into manual_payment_submissions"))
            return { rows: [{ id: "s1", status: "submitted", created_at: new Date().toISOString() }] };
          return { rows: [] };
        },
      }),
  };
  const response = await request(makeApp(db))
    .post("/api/v1/account/payments/p1/manual-submission")
    .send({ giftCardCode: "GIFT-1234-ABCD" });
  assert.equal(response.status, 201);
  assert.ok(statements.some((text) => text.includes("gift_card_code")));
  assert.equal(response.body.data.scanMode, "not_applicable");
});
test("admin gift card review returns code without requiring image evidence", async () => {
  const db = {
    query: async (text) => {
      if (text.startsWith("select id,evidence_storage_path"))
        return { rows: [{ id: "s1", evidence_storage_path: null, evidence_scan_status: "clean", gift_card_code: "GIFT-1234-ABCD" }] };
      return { rows: [] };
    },
  };
  const response = await request(makeApp(db)).get("/api/v1/admin/payments/p1/evidence");
  assert.equal(response.status, 200);
  assert.equal(response.body.data.giftCardCode, "GIFT-1234-ABCD");
  assert.equal(response.body.data.signedUrl, null);
});
function paymentDb({
  duplicate = false,
  amount = 1000,
  currency = "USD",
  status = "pending",
} = {}) {
  const statements = [];
  return {
    statements,
    query: async (text, params) => {
      statements.push({ text, params });
      if (text.startsWith("insert into payment_webhook_events"))
        return { rows: duplicate ? [] : [{ id: "w1" }] };
      return { rows: [] };
    },
    transaction: async (work) =>
      work({
        query: async (text, params) => {
          statements.push({ text, params });
          if (text.startsWith("select p.*"))
            return {
              rows: [
                {
                  id: "p1",
                  order_id: "o1",
                  reference: "ORD-1",
                  amount_minor: amount,
                  currency,
                  status,
                },
              ],
            };
          return { rows: [] };
        },
      }),
  };
}
const responseStub = { locals: { requestId: "request-1" } };
test("verified automatic payment changes only payment and order states", async () => {
  const db = paymentDb();
  const result = await applyVerifiedPayment(db, responseStub, {
    provider: "paypal",
    eventId: "evt-1",
    eventType: "PAYMENT.CAPTURE.COMPLETED",
    payload: {},
    verified: {
      successful: true,
      providerReference: "cap-1",
      orderReference: "ORD-1",
      amountMinor: 1000,
      currency: "USD",
    },
  });
  assert.equal(result.orderStatus, "provider_verified");
  assert.ok(
    db.statements.some(({ text }) =>
      text.includes("status='provider_verified'"),
    ),
  );
  assert.ok(
    db.statements.some(({ text }) =>
      text.includes("status='provider_verified'"),
    ),
  );
  assert.equal(
    db.statements.some(({ text }) =>
      /ticket.*(generate|deliver|email|activate)/i.test(text),
    ),
    false,
  );
});
test("duplicate webhook delivery is ignored", async () => {
  const result = await applyVerifiedPayment(
    paymentDb({ duplicate: true }),
    responseStub,
    {
      provider: "paypal",
      eventId: "same",
      eventType: "capture",
      payload: {},
      verified: { successful: true },
    },
  );
  assert.deepEqual(result, { duplicate: true });
});
test("incorrect automatic payment amount is rejected", async () => {
  const db = paymentDb({ amount: 1000 });
  await assert.rejects(
    () =>
      applyVerifiedPayment(db, responseStub, {
        provider: "paypal",
        eventId: "evt-amount",
        eventType: "capture",
        payload: {},
        verified: {
          successful: true,
          providerReference: "cap",
          orderReference: "ORD-1",
          amountMinor: 999,
          currency: "USD",
        },
      }),
    (error) => error.code === "PAYMENT_AMOUNT_MISMATCH",
  );
  assert.ok(
    db.statements.some(
      ({ text, params }) =>
        text.includes("processing_status='rejected'") &&
        params[1] === "PAYMENT_AMOUNT_MISMATCH",
    ),
  );
});
test("incorrect automatic payment currency is rejected", async () => {
  await assert.rejects(
    () =>
      applyVerifiedPayment(paymentDb(), responseStub, {
        provider: "paypal",
        eventId: "evt-currency",
        eventType: "capture",
        payload: {},
        verified: {
          successful: true,
          providerReference: "cap",
          orderReference: "ORD-1",
          amountMinor: 1000,
          currency: "EUR",
        },
      }),
    (error) => error.code === "PAYMENT_CURRENCY_MISMATCH",
  );
});
test("manual evidence upload validates file type before storage", async () => {
  const db = {
    query: async (text) =>
      text.startsWith("select p.id") ? { rows: [{ id: "p1" }] } : { rows: [] },
  };
  const r = await request(makeApp(db))
    .post("/api/v1/account/payments/p1/evidence-upload")
    .send({
      filename: "proof.exe",
      contentType: "application/octet-stream",
      size: 20,
    });
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, "EVIDENCE_INVALID");
});
test("valid evidence receives a private user/payment-bound upload path", async () => {
  const db = {
    query: async (text) =>
      text.startsWith("select p.id") ? { rows: [{ id: "p1" }] } : { rows: [] },
  };
  const r = await request(makeApp(db))
    .post("/api/v1/account/payments/p1/evidence-upload")
    .send({ filename: "proof.png", contentType: "image/png", size: 200 });
  assert.equal(r.status, 200);
  assert.match(r.body.data.path, /10000000-0000-4000-8000-000000000099\/p1\//);
});
test("manual evidence submission leaves payment under review", async () => {
  const statements = [];
  const db = {
    query: async () => ({ rows: [] }),
    transaction: async (work) =>
      work({
        query: async (text) => {
          statements.push(text);
          if (text.startsWith("select p.id"))
            return {
              rows: [
                {
                  id: "p1",
                  order_id: "o1",
                  provider: "manual",
                  method: "cash_app",
                  status: "payment_details_ready",
                  assignment_id: "a1",
                },
              ],
            };
          if (text.startsWith("insert into manual"))
            return { rows: [{ id: "s1", status: "submitted" }] };
          return { rows: [] };
        },
      }),
  };
  const r = await request(makeApp(db))
    .post("/api/v1/account/payments/p1/manual-submission")
    .send({
      evidenceStoragePath: "10000000-0000-4000-8000-000000000099/p1/proof.png",
      note: "Evidence only",
    });
  assert.equal(r.status, 201);
  assert.match(r.body.data.message, /does not confirm/i);
  assert.equal(
    statements.some((text) => text.includes("status='successful'")),
    false,
  );
});
test("manual evidence submission requires payment proof", async () => {
  const db = {
    transaction: async (work) =>
      work({
        query: async (text) =>
          text.startsWith("select p.id")
            ? {
                rows: [
                  {
                    id: "p1",
                    order_id: "o1",
                    provider: "manual",
                    method: "cash_app",
                    status: "payment_details_ready",
                    assignment_id: "a1",
                  },
                ],
              }
            : { rows: [] },
      }),
    query: async () => ({ rows: [] }),
  };
  const r = await request(makeApp(db))
    .post("/api/v1/account/payments/p1/manual-submission")
    .send({});
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, "EVIDENCE_REQUIRED");
});
for (const method of ["paypal", "cash_app", "chime", "bank_transfer"])
  test(`${method} confirmation requires deliberate admin verification and audit`, async () => {
    const statements = [];
    const db = {
      query: async () => ({ rows: [] }),
      transaction: async (work) =>
        work({
          query: async (text) => {
            statements.push(text);
            if (text.startsWith("select * from payments"))
              return {
                rows: [
                  {
                    id: "10000000-0000-4000-8000-000000000001",
                    order_id: "o1",
                    provider: "manual",
                    method,
                    status: "pending_verification",
                    amount_minor: 1000,
                    currency: "USD",
                  },
                ],
              };
            if (text.startsWith("update payments set status='successful'"))
              return { rows: [{ id: "p1", status: "successful" }] };
            return { rows: [] };
          },
        }),
    };
    const r = await request(makeApp(db))
      .post(
        "/api/v1/admin/payments/10000000-0000-4000-8000-000000000001/confirm",
      )
      .send({
        reason: "Checked the actual business account ledger",
        confirmedAmountMinor: 1000,
        confirmedCurrency: "USD",
      });
    assert.equal(r.status, 200);
    assert.match(r.body.data.message, /Payment successful/i);
    assert.ok(
      statements.some((text) => text.includes("admin_receiving_account_check")),
    );
    assert.ok(statements.some((text) => text.includes("audit_logs")));
    assert.equal(
      statements.some((text) => /generate|deliver|email/i.test(text)),
      false,
    );
  });
test("a successful manual payment cannot be rejected", async () => {
  const db = {
    query: async () => ({ rows: [] }),
    transaction: async (work) =>
      work({
        query: async (text) => {
          if (text.startsWith("select * from payments"))
            return {
              rows: [
                {
                  id: "10000000-0000-4000-8000-000000000001",
                  order_id: "o1",
                  provider: "manual",
                  method: "cash_app",
                  status: "successful",
                },
              ],
            };
          return { rows: [] };
        },
      }),
  };
  const r = await request(makeApp(db))
    .post("/api/v1/admin/payments/10000000-0000-4000-8000-000000000001/reject")
    .send({ reason: "Attempted invalid reversal" });
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, "PAYMENT_STATE_INVALID");
});
test("duplicate checkout key returns the original pending order", async () => {
  const existing = {
    id: "o1",
    reference: "ORD-ORIGINAL",
    status: "pending_payment",
    payment_status: "pending",
    total_minor: 1000,
    currency: "USD",
    reused: true,
  };
  const db = {
    query: async () => ({ rows: [] }),
    transaction: async (work) =>
      work({ query: async () => ({ rows: [existing] }) }),
  };
  const body = {
    eventId: "10000000-0000-4000-8000-000000000001",
    sectionId: "20000000-0000-4000-8000-000000000001",
    quantity: 2,
    paymentMethod: "cash_app",
    contactName: "Test Customer",
    contactEmail: "test@example.com",
  };
  const r = await request(makeApp(db))
    .post("/api/v1/orders")
    .set("Cookie", "customer_access_token=test; customer_csrf=test")
    .set("X-CSRF-Token", "test")
    .set("Idempotency-Key", "same-key")
    .send(body);
  assert.equal(r.status, 201);
  assert.equal(r.body.data.reference, "ORD-ORIGINAL");
  assert.equal(r.body.data.status, "pending_payment");
});
test("concurrent inventory requests cannot oversell", async () => {
  let held = 0;
  let chain = Promise.resolve();
  const db = {
    query: async () => ({ rows: [] }),
    transaction: (work) => {
      const run = chain.then(() =>
        work({
          query: async (text) => {
            if (text.startsWith("select id,reference")) return { rows: [] };
            if (text.startsWith("select es.id"))
              return {
                rows: [
                  {
                    price_minor: 1000,
                    currency: "USD",
                    status: "published",
                    available_quantity: 2,
                    held_quantity: held,
                  },
                ],
              };
            if (text.startsWith("insert into orders"))
              return {
                rows: [
                  {
                    id: crypto.randomUUID(),
                    reference: `ORD-${held}`,
                    status: "pending_payment",
                    payment_status: "pending",
                    total_minor: 2000,
                    currency: "USD",
                  },
                ],
              };
            if (text.startsWith("update ticket_inventory")) {
              held += 2;
              return { rows: [] };
            }
            return { rows: [] };
          },
        }),
      );
      chain = run.catch(() => {});
      return run;
    },
  };
  const body = {
    eventId: "10000000-0000-4000-8000-000000000001",
    sectionId: "20000000-0000-4000-8000-000000000001",
    quantity: 2,
    paymentMethod: "cash_app",
    contactName: "Test Customer",
    contactEmail: "test@example.com",
  };
  const results = await Promise.all(
    ["concurrent-1", "concurrent-2"].map((key) =>
      request(makeApp(db))
        .post("/api/v1/orders")
        .set("Cookie", "customer_access_token=test; customer_csrf=test")
        .set("X-CSRF-Token", "test")
        .set("Idempotency-Key", key)
        .send(body),
    ),
  );
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
  assert.equal(held, 2);
});
test("newsletter subscription accepts a valid email and rejects duplicates", async () => {
  let seenNew = false;
  const db = {
    query: async (sql, params) => {
      if (sql.includes("from newsletter_subscribers")) {
        const email = String(params[0] || "");
        if (email === "existing@example.com") {
          return { rows: [{ id: "n1", email, status: "active" }] };
        }
        if (email === "new@example.com") {
          return { rows: [] };
        }
      }
      if (sql.includes("insert into newsletter_subscribers")) {
        seenNew = true;
        return { rows: [{ id: "n2", email: String(params[0] || ""), status: "active" }] };
      }
      return { rows: [] };
    },
  };
  const first = await request(makeApp(db)).post("/api/v1/newsletter/subscribe").send({ email: "new@example.com" });
  assert.equal(first.status, 201);
  assert.equal(first.body.data.email, "new@example.com");
  const duplicate = await request(makeApp(db)).post("/api/v1/newsletter/subscribe").send({ email: "existing@example.com" });
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.body.data.status, "already_subscribed");
  const invalid = await request(makeApp(db)).post("/api/v1/newsletter/subscribe").send({ email: "bad-email" });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.error.code, "VALIDATION_ERROR");
  assert.equal(seenNew, true);
});
test("public membership application persists pending status", async () => {
  const db = {
    query: async () => ({ rows: [{ id: "m1", status: "pending" }] }),
  };
  const r = await request(makeApp(db))
    .post("/api/v1/membership-applications")
    .send({
      fullName: "Test User",
      email: "user@example.com",
      country: "US",
      reason: "A sufficiently detailed reason",
      interest: "exclusive_content",
    });
  assert.equal(r.status, 201);
  assert.equal(r.body.data.status, "pending");
});
test("membership approval accepts an omitted internal review note", async () => {
  const application = {
    id: "20000000-0000-4000-8000-000000000001",
    profile_id: "30000000-0000-4000-8000-000000000001",
    status: "approved",
  };
  const queries = [];
  const db = {
    query: async () => ({ rows: [] }),
    transaction: async (callback) => callback({
      query: async (sql, params) => {
        queries.push({ sql, params });
        return sql.startsWith("update membership_applications")
          ? { rows: [application] }
          : { rows: [] };
      },
    }),
  };
  const r = await request(makeApp(db))
    .post(`/api/v1/admin/membership-applications/${application.id}/decision`)
    .send({ decision: "approved" });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.status, "approved");
  assert.ok(queries.some(({ sql }) => sql.includes("insert into memberships")));
  assert.equal(queries[0].params[2], null);
});
test("manual payment confirmation activates a matching membership application", async () => {
  const queries = [];
  const db = {
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (sql.startsWith("select * from payments")) {
        return {
          rows: [{ id: "10000000-0000-4000-8000-000000000001", order_id: "o1", provider: "manual", method: "cash_app", status: "pending_verification", amount_minor: 1000, currency: "USD" }],
        };
      }
      if (sql.includes("select id,profile_id from orders")) {
        return { rows: [{ id: "o1", profile_id: "30000000-0000-4000-8000-000000000001" }] };
      }
      if (sql.includes("select * from membership_applications where profile_id")) {
        return { rows: [{ id: "a1", profile_id: "30000000-0000-4000-8000-000000000001", status: "pending" }] };
      }
      if (sql.startsWith("update payments set status='successful'")) {
        return { rows: [{ id: "p1", status: "successful" }] };
      }
      return { rows: [] };
    },
    transaction: async (callback) => callback({
      query: async (sql, params) => {
        queries.push({ sql, params });
        if (sql.startsWith("select * from payments")) {
          return {
            rows: [{ id: "10000000-0000-4000-8000-000000000001", order_id: "o1", provider: "manual", method: "cash_app", status: "pending_verification", amount_minor: 1000, currency: "USD" }],
          };
        }
        if (sql.includes("select id,profile_id from orders")) {
          return { rows: [{ id: "o1", profile_id: "30000000-0000-4000-8000-000000000001" }] };
        }
        if (sql.includes("select * from membership_applications where profile_id")) {
          return { rows: [{ id: "a1", profile_id: "30000000-0000-4000-8000-000000000001", status: "pending" }] };
        }
        if (sql.startsWith("update payments set status='successful'")) {
          return { rows: [{ id: "p1", status: "successful" }] };
        }
        return { rows: [] };
      },
    }),
  };
  const r = await request(makeApp(db))
    .post("/api/v1/admin/payments/10000000-0000-4000-8000-000000000001/confirm")
    .send({ reason: "Checked the actual business account ledger", confirmedAmountMinor: 1000, confirmedCurrency: "USD" });
  assert.equal(r.status, 200);
  assert.ok(queries.some(({ sql }) => sql.includes("insert into memberships")));
  assert.match(r.body.data.message, /Payment successful/i);
});
test("public service request persists a new request", async () => {
  const db = { query: async () => ({ rows: [{ id: "s1", status: "new" }] }) };
  const r = await request(makeApp(db)).post("/api/v1/service-requests").send({
    category: "general",
    fullName: "Test User",
    email: "user@example.com",
    message: "A sufficiently detailed request",
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.data.status, "new");
});
test("public support request persists safely", async () => {
  const db = { query: async () => ({ rows: [{ id: "s1" }] }) };
  const r = await request(makeApp(db)).post("/api/v1/support-requests").send({
    name: "Test User",
    email: "user@example.com",
    message: "A sufficiently detailed support request",
  });
  assert.equal(r.status, 201);
});
test("login endpoint rate limits repeated attempts", async () => {
  const auth = fakeAuth();
  auth.anon.auth.signInWithPassword = async () => ({
    data: {},
    error: new Error("bad"),
  });
  const db = { query: async () => ({ rows: [] }) };
  const application = makeApp(db, auth);
  let response;
  for (let index = 0; index < 9; index++)
    response = await request(application)
      .post("/api/v1/auth/login")
      .send({ email: "user@example.com", password: "password123" });
  assert.equal(response.status, 429);
});
