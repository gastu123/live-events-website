import "dotenv/config";
import fs from "node:fs";
import pg from "pg";
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required.");
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl:
    process.env.NODE_ENV === "production"
      ? { rejectUnauthorized: false }
      : undefined,
});
try {
  await pool.query(fs.readFileSync("supabase/seed.sql", "utf8"));
  console.log("Fictional development seed applied.");
} finally {
  await pool.end();
}
