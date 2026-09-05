import pg from "pg";
import dotenv from "dotenv";

dotenv.config();

const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
});

await client.connect();

try {
  console.log("\n=== EVIDENCE SUBMISSIONS ===\n");
  const result = await client.query(`
    SELECT 
      id,
      payment_id,
      evidence_storage_path,
      evidence_scan_status,
      status,
      created_at,
      updated_at
    FROM manual_payment_submissions
    WHERE evidence_storage_path IS NOT NULL
    ORDER BY created_at DESC
    LIMIT 10
  `);

  console.log(`Found ${result.rows.length} evidence submissions:\n`);
  result.rows.forEach((row) => {
    console.log(`ID: ${row.id}`);
    console.log(`  Payment ID: ${row.payment_id}`);
    console.log(`  Storage Path: ${row.evidence_storage_path}`);
    console.log(`  SCAN STATUS: ${row.evidence_scan_status}`);
    console.log(`  Submission Status: ${row.status}`);
    console.log(`  Created: ${row.created_at}`);
    console.log(`  Updated: ${row.updated_at}`);
    console.log();
  });

  // Check if any evidence is in pending_scan state
  const pending = await client.query(
    `SELECT COUNT(*) as count FROM manual_payment_submissions WHERE evidence_scan_status = 'pending'`
  );
  console.log(`\n${pending.rows[0].count} evidence files still PENDING scan\n`);

  // Check database schema for evidence_scan_status
  const schema = await client.query(`
    SELECT column_name, data_type, column_default, is_nullable
    FROM information_schema.columns
    WHERE table_name = 'manual_payment_submissions'
    AND column_name IN ('evidence_scan_status', 'evidence_storage_path', 'status')
  `);
  console.log("\n=== COLUMN SCHEMA ===\n");
  console.log(schema.rows);

} catch (error) {
  console.error("Error:", error.message);
} finally {
  await client.end();
}
