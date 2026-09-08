import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import request from "supertest";
import { loadConfig } from "../server/config.js";
import { createApp } from "../server/app.js";
import {
  credentials,
  eventInput,
  orderInput,
  serviceInput,
  supportInput,
} from "../server/schemas.js";
import { manualProvider } from "../server/payments/manual.js";

const root = path.resolve(".");
const validEnv = {
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
};
const logger = {
  child() {
    return this;
  },
  info() {},
  error() {},
};
function orderDb({ available = 10, existing = null, price = 7500 } = {}) {
  return {
    query: async () => ({ rows: [] }),
    close: async () => {},
    transaction: async (work) => {
      let call = 0;
      return work({
        query: async (sql) => {
          call++;
          if (call === 1) return { rows: existing ? [existing] : [] };
          if (call === 2)
            return {
              rows: [
                {
                  id: "20000000-0000-4000-8000-000000000001",
                  event_id: "10000000-0000-4000-8000-000000000001",
                  price_minor: price,
                  currency: "USD",
                  status: "published",
                  available_quantity: available,
                  held_quantity: 0,
                },
              ],
            };
          if (sql.startsWith("insert into orders"))
            return {
              rows: [
                {
                  id: "30000000-0000-4000-8000-000000000001",
                  reference: "ORD-TEST",
                  status: "pending_payment",
                  payment_status: "pending",
                  total_minor: price * 2,
                  currency: "USD",
                  hold_expires_at: new Date(),
                },
              ],
            };
          return { rows: [] };
        },
      });
    },
  };
}
function app(db = orderDb()) {
  const unauthorized = (_req, _res, next) => {
    const error = new Error("Authentication required");
    error.status = 401;
    error.code = "AUTHENTICATION_REQUIRED";
    next(error);
  };
  const auth = {
    service: {
      auth: {
        getUser: async () => ({
          data: { user: { id: "10000000-0000-4000-8000-000000000099" } },
        }),
      },
    },
    requireUser: unauthorized,
    requireAdmin: () => unauthorized,
  };
  return createApp({
    config: loadConfig(validEnv),
    db,
    logger,
    services: { auth },
  });
}
const order = {
  eventId: "10000000-0000-4000-8000-000000000001",
  sectionId: "20000000-0000-4000-8000-000000000001",
  quantity: 2,
  paymentMethod: "cash_app",
  contactName: "Test Customer",
  contactEmail: "test@example.com",
};

test("environment accepts a complete safe configuration", () =>
  assert.equal(loadConfig(validEnv).PORT, 3000));
test("environment rejects a short cookie secret", () =>
  assert.throws(
    () => loadConfig({ ...validEnv, COOKIE_SECRET: "short" }),
    /COOKIE_SECRET/,
  ));
test("credentials reject weak passwords", () =>
  assert.equal(
    credentials.safeParse({ email: "a@b.com", password: "short" }).success,
    false,
  ));
test("credentials accept a simple letter-and-number password", () =>
  assert.equal(
    credentials.safeParse({ email: "a@b.com", password: "Admin1234" }).success,
    true,
  ));
test("event validation requires positive shape", () =>
  assert.equal(eventInput.safeParse({ title: "X" }).success, false));
test("order validation rejects zero quantity", () =>
  assert.equal(orderInput.safeParse({ ...order, quantity: 0 }).success, false));
test("order validation accepts gift cards", () =>
    assert.equal(
    orderInput.safeParse({ ...order, paymentMethod: "gift_card" }).success,
    true,
  ));
test("order validation accepts every supported off-site transfer method", () => {
  for (const paymentMethod of [
    "paypal",
    "cash_app",
    "chime",
    "bank_transfer",
    "gift_card",
  ])
    assert.equal(
      orderInput.safeParse({ ...order, paymentMethod }).success,
      true,
    );
});
test("service validation rejects unknown categories", () =>
  assert.equal(
    serviceInput.safeParse({
      category: "ticket_transfer",
      fullName: "Test User",
      email: "a@b.com",
      message: "A sufficiently long message",
    }).success,
    false,
  ));
test("support validation includes honeypot spam protection", () =>
  assert.equal(
    supportInput.safeParse({
      name: "Test User",
      email: "a@b.com",
      message: "A sufficiently long message",
      website: "spam",
    }).success,
    false,
  ));
test("manual provider never auto-verifies evidence", () =>
  assert.throws(() => manualProvider.verify(), /administrator/));
test("health endpoint returns a request ID", async () => {
  const r = await request(app()).get("/api/v1/health");
  assert.equal(r.status, 200);
  assert.ok(r.body.requestId);
});
test("strict CORS rejects an unapproved origin", async () => {
  const r = await request(app())
    .get("/api/v1/health")
    .set("Origin", "https://evil.example");
  assert.equal(r.status, 403);
});
test("new manual order starts pending", async () => {
  const r = await request(app())
    .post("/api/v1/orders")
    .set("Cookie", "customer_access_token=test; customer_csrf=test")
    .set("X-CSRF-Token", "test")
    .set("Idempotency-Key", "test-key-1")
    .send(order);
  assert.equal(r.status, 201);
  assert.equal(r.body.data.status, "awaiting_payment_details");
  assert.equal(r.body.data.payment_status, "awaiting_payment_details");
  assert.equal(
    r.body.data.message,
    "Preparing your payment details. An administrator has been notified and your payment instructions will appear here shortly.",
  );
});
test("server calculates price from locked database row", async () => {
  const r = await request(app(orderDb({ price: 12345 })))
    .post("/api/v1/orders")
    .set("Cookie", "customer_access_token=test; customer_csrf=test")
    .set("X-CSRF-Token", "test")
    .set("Idempotency-Key", "test-key-2")
    .send({ ...order, total_minor: 1 });
  assert.equal(Number(r.body.data.total_minor), 24690);
});
test("overselling is rejected", async () => {
  const r = await request(app(orderDb({ available: 1 })))
    .post("/api/v1/orders")
    .set("Cookie", "customer_access_token=test; customer_csrf=test")
    .set("X-CSRF-Token", "test")
    .set("Idempotency-Key", "test-key-3")
    .send(order);
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, "INSUFFICIENT_INVENTORY");
});
test("card checkout is excluded from the manual payment workflow", async () => {
  const r = await request(app())
    .post("/api/v1/orders")
    .set("Cookie", "customer_access_token=test; customer_csrf=test")
    .set("X-CSRF-Token", "test")
    .set("Idempotency-Key", "test-key-4")
    .send({ ...order, paymentMethod: "card" });
  assert.equal(r.status, 400);
});
test("checkout requires an idempotency key", async () => {
  const r = await request(app()).post("/api/v1/orders").send(order);
  assert.equal(r.status, 400);
});
test("unknown API routes return consistent JSON", async () => {
  const r = await request(app()).get("/api/v1/missing");
  assert.equal(r.status, 404);
  assert.equal(r.body.success, false);
});
test("admin endpoints reject unauthenticated users", async () => {
  const r = await request(app()).get("/api/v1/admin/overview");
  assert.equal(r.status, 401);
});
test("admin HTML is served with noindex response headers", async () => {
  const r = await request(app()).get("/admin.html");
  assert.match(r.headers["x-robots-tag"], /noindex/);
});
test("frontend contains no raw card fields or fulfilment success claims", () => {
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  assert.doesNotMatch(html, /name="(?:card-number|cvv|expiry)"/);
  assert.doesNotMatch(
    html,
    /Your tickets are ready|Tickets have been emailed|You're going to the show|ORDER CONFIRMED/i,
  );
});
test("admin Support Inbox stays removed while public Support remains", () => {
  const admin = fs.readFileSync(path.join(root, "admin.html"), "utf8");
  const publicHtml = fs.readFileSync(path.join(root, "index.html"), "utf8");
  assert.doesNotMatch(admin, /Support Inbox|data-admin-page="support"/i);
  assert.match(publicHtml, /id="support-form"/);
});
test("admin contains no fulfilment or scanning controls", () => {
  const html = fs.readFileSync(path.join(root, "admin.html"), "utf8");
  assert.doesNotMatch(
    html,
    /data-action="(?:scan-ticket|issue-ticket|view-ticket)"/,
  );
});
test("service worker excludes API and admin document caching", () => {
  const sw = fs.readFileSync(path.join(root, "admin-sw.js"), "utf8");
  assert.match(sw, /pathname\.startsWith\("\/api\/"\)/);
  assert.match(sw, /pathname\s*===\s*"\/admin\.html"/);
  assert.doesNotMatch(
    sw,
    /orders|payments|evidence|access_token|refresh_token/i,
  );
});
test("schema contains no fulfilment, QR, wallet, or check-in tables", () => {
  const sql = fs.readFileSync(
    path.join(root, "supabase/migrations/001_initial_schema.sql"),
    "utf8",
  );
  assert.doesNotMatch(
    sql,
    /create table (tickets|qr_codes|ticket_wallets|check_ins)/i,
  );
});
