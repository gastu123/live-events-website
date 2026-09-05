import "dotenv/config";
import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";

test(
  "optional Supabase schema and constraints integration",
  {
    skip:
      !process.env.TEST_DATABASE_URL ||
      process.env.SKIP_DATABASE_INTEGRATION === "true",
  },
  async () => {
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    });
    try {
      const result = await pool.query(
        "select to_regclass('public.orders') orders,to_regclass('public.payments') payments,to_regclass('public.ticket_inventory') inventory,to_regclass('public.payment_destinations') destinations,to_regclass('public.payment_assignments') assignments,to_regclass('public.payment_evidence_access_logs') evidence_access,to_regclass('public.admin_password_otps') admin_otps",
      );
      assert.equal(result.rows[0].orders, "orders");
      assert.equal(result.rows[0].payments, "payments");
      assert.equal(result.rows[0].inventory, "ticket_inventory");
      assert.equal(result.rows[0].destinations, "payment_destinations");
      assert.equal(result.rows[0].assignments, "payment_assignments");
      assert.equal(
        result.rows[0].evidence_access,
        "payment_evidence_access_logs",
      );
      assert.equal(result.rows[0].admin_otps, "admin_password_otps");
      const columns = await pool.query(
        "select count(*)::int count from information_schema.columns where table_schema='public' and table_name='payment_assignments' and column_name in ('payment_method','account_name','payment_identifier','instructions')",
      );
      assert.equal(columns.rows[0].count, 4);
      const statuses = await pool.query(
        "select public.release_expired_order_holds() released",
      );
      assert.ok(Number.isInteger(statuses.rows[0].released));
      const expired = await pool.query(
        "select public.expire_payment_assignments() expired",
      );
      assert.ok(Number.isInteger(expired.rows[0].expired));
    } finally {
      await pool.end();
    }
  },
);
