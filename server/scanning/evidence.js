import { basename } from "node:path";
import { VirusTotalScanner } from "./virustotal.js";

export function getEvidenceScanMode(apiKey) {
  return apiKey ? "virus_total" : "local_validation";
}

export async function scanEvidenceBuffer({ fileBuffer, filename, apiKey }) {
  const scanner = new VirusTotalScanner(apiKey);
  return scanner.scanFile(fileBuffer, filename);
}

export async function processPendingEvidenceQueue({
  db,
  storage,
  bucketName,
  apiKey,
  limit = 25,
  submissionId = null,
}) {
  const rows = (
    await db.query(
      `select id,evidence_storage_path,evidence_scan_status
       from manual_payment_submissions
       where evidence_storage_path is not null
         and evidence_scan_status = 'pending'
         and ($1::uuid is null or id = $1)
       order by created_at asc
       limit $2`,
      [submissionId, limit],
    )
  ).rows;

  const results = [];
  for (const row of rows) {
    try {
      const { data, error } = await storage
        .from(bucketName)
        .download(row.evidence_storage_path);

      if (error) {
        results.push({
          submissionId: row.id,
          status: "pending",
          skipped: true,
          reason: `Evidence could not be downloaded for scanning: ${error.message}`,
        });
        continue;
      }

      const fileBuffer = Buffer.from(await data.arrayBuffer());
      const scanResult = await scanEvidenceBuffer({
        fileBuffer,
        filename: basename(row.evidence_storage_path),
        apiKey,
      });

      const nextStatus = scanResult.clean ? "clean" : "rejected";
      await db.query(
        "update manual_payment_submissions set evidence_scan_status=$1,updated_at=now() where id=$2",
        [nextStatus, row.id],
      );

      await db.query(
        `insert into evidence_scan_logs
          (submission_id, scan_status, clean, malicious_count, suspicious_count, vendor_results, scanned_at)
         values ($1,$2,$3,$4,$5,$6,now())`,
        [
          row.id,
          nextStatus,
          scanResult.clean,
          scanResult.stats?.malicious || 0,
          scanResult.stats?.suspicious || 0,
          JSON.stringify(scanResult.stats || {}),
        ],
      );

      results.push({
        submissionId: row.id,
        status: nextStatus,
        mode: getEvidenceScanMode(apiKey),
        reason: scanResult.reason,
        clean: scanResult.clean,
        stats: scanResult.stats,
      });
    } catch (error) {
      results.push({
        submissionId: row.id,
        status: "pending",
        skipped: true,
        reason: error.message,
      });
    }
  }

  return results;
}

export async function processEvidenceSubmission({
  db,
  storage,
  bucketName,
  submissionId,
  apiKey,
}) {
  const result = await processPendingEvidenceQueue({
    db,
    storage,
    bucketName,
    apiKey,
    limit: 1,
    submissionId,
  });
  return result[0] || { status: "pending", skipped: true, reason: "No evidence to process" };
}
