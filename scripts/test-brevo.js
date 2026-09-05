import "dotenv/config";
import { loadConfig } from "../server/config.js";
import { createBrevoMailer } from "../server/email/brevo.js";

if (process.env.npm_lifecycle_event === "test:brevo") {
  const config = loadConfig();
  const mailer = createBrevoMailer(config);
  if (config.EMAIL_PROVIDER !== "brevo" || !mailer.enabled)
    throw new Error("Brevo is not fully configured in the local environment.");
  await mailer.sendTestEmail({ to: config.INITIAL_SUPER_ADMIN_EMAIL });
  console.log(`Brevo test email accepted for delivery to ${config.INITIAL_SUPER_ADMIN_EMAIL}.`);
}
