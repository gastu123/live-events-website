/**
 * Evidence Malware Scanning Service
 * 
 * Primary: VirusTotal - Scans evidence files using VirusTotal's public API.
 *          VirusTotal aggregates results from 70+ antivirus engines.
 *          Free tier: 500 queries/day, rate limit 4 requests/minute
 *          API Reference: https://developers.virustotal.com/reference/overview
 *
 * Fallback: Local file signature scanning - Basic safety checks without external API
 *           Validates file magic bytes, size, and content patterns
 */

import crypto from "crypto";

const VIRUSTOTAL_API_URL = "https://www.virustotal.com/api/v3";
const POLL_INTERVAL_MS = 10000; // Poll every 10 seconds for scan results
const MAX_POLL_ATTEMPTS = 30; // 5 minutes total (30 * 10 seconds)

/**
 * Sleep helper for delays
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Calculate SHA256 hash of file for duplicate detection
 */
function calculateFileSha256(fileBuffer) {
  return crypto.createHash("sha256").update(fileBuffer).digest("hex");
}

/**
 * Basic local file validation - checks magic bytes and file patterns
 */
function performLocalScan(fileBuffer, filename) {
  const suspiciousSignatures = [
    // Executable patterns
    Buffer.from([0x4d, 0x5a]), // MZ - DOS/Windows executable
    Buffer.from([0x7f, 0x45, 0x4c, 0x46]), // ELF - Linux executable
    Buffer.from([0xca, 0xfe, 0xba, 0xbe]), // Mach-O - macOS executable
    Buffer.from([0xfe, 0xed, 0xfa]), // Mach-O fat binary
  ];

  const fileMagic = fileBuffer.slice(0, 4);

  for (const sig of suspiciousSignatures) {
    if (fileMagic.indexOf(sig) === 0) {
      return {
        clean: false,
        reason: `Detected suspicious file type: ${filename}`,
        stats: {
          malicious: 1,
          suspicious: 0,
          undetected: 0,
          harmless: 0,
        },
      };
    }
  }

  // File size limits (5 MB max)
  if (fileBuffer.length > 5 * 1024 * 1024) {
    return {
      clean: false,
      reason: "File exceeds maximum size",
      stats: {
        malicious: 1,
        suspicious: 0,
        undetected: 0,
        harmless: 0,
      },
    };
  }

  // If it passes basic checks, mark as clean
  return {
    clean: true,
    reason: "Passed local file validation (no external API key configured)",
    stats: {
      malicious: 0,
      suspicious: 0,
      undetected: 0,
      harmless: 1,
    },
  };
}

/**
 * VirusTotal file scanning service
 */
export class VirusTotalScanner {
  constructor(apiKey) {
    this.apiKey = apiKey;
  }

  /**
   * Submit a file for scanning
   * Returns analysis ID for polling
   */
  async submitFile(fileBuffer, filename) {
    const formData = new FormData();
    formData.append(
      "file",
      new globalThis.Blob([fileBuffer], { type: "application/octet-stream" }),
      filename,
    );

    const response = await fetch(`${VIRUSTOTAL_API_URL}/files`, {
      method: "POST",
      headers: {
        "x-apikey": this.apiKey,
      },
      body: formData,
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(
        `VirusTotal upload failed: ${response.status} - ${error.error?.message || "Unknown error"}`
      );
    }

    const data = await response.json();
    return data.data.id; // Returns analysis ID like "aGVsbG8gd29ybGQ="
  }

  /**
   * Get scan results for a submitted file
   * Returns { status: 'queued' | 'completed', results: {...} | null }
   */
  async getScanResult(analysisId) {
    const response = await fetch(`${VIRUSTOTAL_API_URL}/analyses/${analysisId}`, {
      method: "GET",
      headers: {
        "x-apikey": this.apiKey,
      },
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(
        `VirusTotal scan lookup failed: ${response.status} - ${error.error?.message || "Unknown error"}`
      );
    }

    const data = await response.json();
    const status = data.data.attributes.status; // 'queued', 'completed', etc.

    if (status === "completed") {
      return {
        status: "completed",
        results: {
          stats: data.data.attributes.stats, // { malicious: 0, suspicious: 0, undetected: 70, harmless: 0 }
          results: data.data.attributes.results, // Detailed per-engine results
        },
      };
    }

    return { status };
  }

  /**
   * Poll for scan results until completion or timeout
   * Returns { malicious: count, suspicious: count, undetected: count, harmless: count }
   */
  async pollForResults(analysisId, maxAttempts = MAX_POLL_ATTEMPTS) {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const result = await this.getScanResult(analysisId);

      if (result.status === "completed") {
        return result.results.stats;
      }

      if (attempt < maxAttempts - 1) {
        await sleep(POLL_INTERVAL_MS);
      }
    }

    throw new Error(`VirusTotal scan timeout after ${maxAttempts} attempts`);
  }

  /**
   * Scan a file and return verdict
   * Returns { clean: boolean, stats: {...}, reason: string, method: string }
   */
  async scanFile(fileBuffer, filename) {
    if (!this.apiKey) {
      // Fallback to local scanning
      console.log(`[LocalScanner] Performing local file validation: ${filename}`);
      const result = performLocalScan(fileBuffer, filename);
      return {
        ...result,
        method: "local",
      };
    }

    console.log(`[VirusTotal] Submitting file for scan: ${filename}`);

    // Submit file
    const analysisId = await this.submitFile(fileBuffer, filename);
    console.log(`[VirusTotal] Analysis ID: ${analysisId}`);

    // Poll for results
    console.log(`[VirusTotal] Polling for scan results...`);
    const stats = await this.pollForResults(analysisId);

    console.log(`[VirusTotal] Scan complete. Stats:`, stats);

    // Verdict: file is clean if no malicious or suspicious engines detected it
    const clean = stats.malicious === 0 && stats.suspicious === 0;
    const reason =
      stats.malicious > 0
        ? `Detected by ${stats.malicious} antivirus engines`
        : stats.suspicious > 0
          ? `Flagged suspicious by ${stats.suspicious} engines`
          : `Scanned by ${Object.values(stats).reduce((a, b) => a + b, 0)} engines - clean`;

    return {
      clean,
      stats,
      reason,
      method: "virustotal",
    };
  }
}

/**
 * Batch scanner for multiple evidence files
 * Handles rate limiting (4 requests/minute for free tier)
 */
export class VirusTotalBatchScanner {
  constructor(apiKey) {
    this.scanner = new VirusTotalScanner(apiKey);
    this.requestsInLastMinute = 0;
    this.lastResetTime = Date.now();
  }

  async waitForRateLimit() {
    if (!this.scanner.apiKey) {
      // No rate limit for local scanning
      return;
    }

    const now = Date.now();
    const timeSinceReset = now - this.lastResetTime;

    if (timeSinceReset > 60000) {
      // Reset after 1 minute
      this.requestsInLastMinute = 0;
      this.lastResetTime = now;
    }

    if (this.requestsInLastMinute >= 4) {
      // Free tier limit: 4 requests per minute
      const waitTime = 60000 - timeSinceReset;
      console.log(`[Rate Limit] Waiting ${Math.ceil(waitTime / 1000)}s before next request...`);
      await sleep(waitTime);
      this.requestsInLastMinute = 0;
      this.lastResetTime = Date.now();
    }

    this.requestsInLastMinute++;
  }

  async scanFileWithRateLimit(fileBuffer, filename) {
    await this.waitForRateLimit();
    return this.scanner.scanFile(fileBuffer, filename);
  }
}

/**
 * Export utility functions
 */
export { calculateFileSha256 };
