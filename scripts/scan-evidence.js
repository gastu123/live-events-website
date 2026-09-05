/**
 * Evidence Malware Scanning Worker
 * 
 * Scans pending evidence files using VirusTotal.
 * 
 * Usage:
 *   node scripts/scan-evidence.js              # Scan all pending evidence
 *   node scripts/scan-evidence.js --limit 5    # Scan up to 5 pending files
 *   node scripts/scan-evidence.js --dry-run    # Preview what would be scanned
 * 
 * This script:
 * 1. Queries the database for evidence files with status='pending'
 * 2. Downloads each file from Supabase Storage
 * 3. Submits to VirusTotal for scanning
 * 4. Polls for results (with exponential backoff)
 * 5. Updates database: evidence_scan_status = 'clean' or 'rejected'
 * 6. Logs all scan results for audit
 * 
 * Configuration:
 *   VIRUSTOTAL_API_KEY   - Required for scanning (https://www.virustotal.com/gui/my-apikey)
 *   DATABASE_URL         - PostgreSQL connection
 *   SUPABASE_URL         - Storage bucket URL
 *   SUPABASE_SERVICE_ROLE_KEY - Private key for storage access
 */

import pg from "pg";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { processPendingEvidenceQueue } from "../server/scanning/evidence.js";

dotenv.config();

const db = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Parse command-line arguments
const args = new Map(
  process.argv.slice(2).map((arg) => {
    if (arg.startsWith("--")) {
      const [key, value] = arg.substring(2).split("=");
      return [key, value || true];
    }
    return [null, arg];
  })
);

const dryRun = args.get("dry-run") === true;
const limit = args.get("limit") ? parseInt(args.get("limit")) : 100;

async function main() {
  try {
    console.log("\n=== EVIDENCE MALWARE SCANNING ===\n");

    // Verify VirusTotal API key
    if (!process.env.VIRUSTOTAL_API_KEY) {
      console.log("\n⚠️  VIRUSTOTAL_API_KEY not configured");
      console.log("   Using local file validation scanner");
      console.log("   To use VirusTotal (70+ antivirus engines):");
      console.log("   1. Get a free API key: https://www.virustotal.com/gui/my-apikey");
      console.log("   2. Set VIRUSTOTAL_API_KEY=your_api_key in .env");
      console.log("");
    } else {
      console.log("✓ VirusTotal API key configured\n");
    }

    const pending = await db.query(
      `SELECT id,evidence_storage_path,evidence_scan_status
       FROM manual_payment_submissions
       WHERE evidence_storage_path IS NOT NULL
         AND evidence_scan_status = 'pending'
       ORDER BY created_at ASC
       LIMIT $1`,
      [limit],
    );

    const submissions = pending.rows;
    console.log(`Found ${submissions.length} pending evidence file(s)\n`);

    if (submissions.length === 0) {
      console.log("✅ No pending evidence to scan");
      process.exit(0);
    }

    if (dryRun) {
      console.log("📋 DRY RUN - Would scan these files:\n");
      submissions.forEach((sub) => {
        console.log(`  • ${sub.evidence_storage_path}`);
      });
      console.log("\nRun without --dry-run to actually scan files");
      process.exit(0);
    }

    const results = await processPendingEvidenceQueue({
      db,
      storage: supabase.storage,
      bucketName: process.env.MANUAL_PAYMENT_EVIDENCE_BUCKET || "manual-payment-evidence",
      apiKey: process.env.VIRUSTOTAL_API_KEY || "",
      limit,
    });

    let scannedCount = 0;
    let cleanCount = 0;
    let rejectedCount = 0;
    let errorCount = 0;

    for (const result of results) {
      scannedCount++;
      if (result.skipped) errorCount++;
      else if (result.clean) cleanCount++;
      else rejectedCount++;
      console.log(`Submission ${result.submissionId}: ${result.status} (${result.reason || "processed"})`);
    }

    console.log("\n=== SCAN SUMMARY ===");
    console.log(`Total scanned: ${scannedCount}`);
    console.log(`  ✅ Clean: ${cleanCount}`);
    console.log(`  ⚠️  Rejected: ${rejectedCount}`);
    console.log(`  ❌ Errors: ${errorCount}`);
    process.exit(errorCount > 0 ? 1 : 0);
  } catch (error) {
    console.error("Fatal error:", error.message);
    console.error(error.stack);
    process.exit(1);
  } finally {
    await db.end();
  }
}

main().catch(console.error);
