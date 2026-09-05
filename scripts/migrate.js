import "dotenv/config";
import crypto_nf from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import pg from "pg";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required.");

const directory = path.resolve("supabase/migrations");
const files = fs
  .readdirSync(directory)
  .filter((name) => name.endsWith(".sql"))
  .sort();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

try {
  await pool.query(`create table if not exists public.app_schema_migrations (
    name text primary key,
    checksum text not null,
    applied_at timestamptz not null default now()
  )`);
  for (const name of files) {
    const sql = fs.readFileSync(path.join(directory, name), "utf8");
    const checksum = crypto_nf.createHash("sha256").update(sql).digest("hex");
    const existing = await pool.query(
      "select checksum from public.app_schema_migrations where name=$1",
      [name],
    );
    if (existing.rows[0]) {
      if (existing.rows[0].checksum !== checksum)
        throw new Error(`Previously applied migration was modified: ${name}`);
      console.log(`Migration already applied: ${name}`);
      continue;
    }
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(sql);
      await client.query(
        "insert into public.app_schema_migrations(name,checksum) values($1,$2)",
        [name, checksum],
      );
      await client.query("commit");
      console.log(`Applied migration: ${name}`);
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }
} finally {
  await pool.end();
}
