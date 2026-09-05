import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createDatabase } from "./db.js";
import { createLogger } from "./logger.js";
import { processPendingEvidenceQueue } from "./scanning/evidence.js";

const config = loadConfig();
const logger = createLogger(config.LOG_LEVEL);
const db = createDatabase(config.DATABASE_URL);
const app = createApp({ config, db, logger });
const supabase = createClient(
  config.SUPABASE_URL,
  config.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } },
);
async function scanPendingEvidenceOnStartup() {
  try {
    const rows = await processPendingEvidenceQueue({
      db,
      storage: supabase.storage,
      bucketName: config.MANUAL_PAYMENT_EVIDENCE_BUCKET,
      apiKey: config.VIRUSTOTAL_API_KEY,
      limit: 25,
    });
    if (rows.length) {
      logger.info({ rows }, "startup evidence backlog processed");
    }
  } catch (error) {
    logger.error({ err: error }, "startup evidence backlog check failed");
  }
}
const server = app.listen(config.PORT, () => {
  logger.info(
    {
      port: config.PORT,
      developmentDemo: config.DEVELOPMENT_DEMO,
      publicUrl: config.PUBLIC_ORIGIN,
      adminUrl: `${config.ADMIN_ORIGIN}/admin.html`,
    },
    "server listening",
  );
  scanPendingEvidenceOnStartup();
});
let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, "graceful shutdown started");
  server.close(async () => {
    await db.close();
    logger.info("graceful shutdown complete");
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("unhandledRejection", (error) =>
  logger.error({ err: error }, "unhandled rejection"),
);
