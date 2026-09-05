import { z } from "zod";

const bool = z
  .string()
  .default("false")
  .transform((value) => value === "true");
const schema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    PUBLIC_ORIGIN: z.string().url(),
    ADMIN_ORIGIN: z.string().url(),
    DATABASE_URL: z.string().min(1),
    SUPABASE_URL: z.string().url(),
    SUPABASE_ANON_KEY: z.string().min(1),
    SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
    COOKIE_SECRET: z.string().min(32),
    LOG_LEVEL: z.string().default("info"),
    TRUST_PROXY: bool,
    ADMIN_ALLOWED_COUNTRIES: z.string().default(""),
    ADMIN_ALLOWED_IPS: z.string().default(""),
    MANUAL_PAYMENT_EVIDENCE_BUCKET: z
      .string()
      .min(1)
      .default("manual-payment-evidence"),
    INITIAL_SUPER_ADMIN_EMAIL: z.string().email().default("aaniebiet95@gmail.com"),
    INITIAL_SUPER_ADMIN_PASSWORD: z.string().default(""),
    BREVO_API_KEY: z.string().default(""),
    BREVO_SENDER_EMAIL: z.union([z.string().email(), z.literal("")]).default(""),
    BREVO_SENDER_NAME: z.string().max(100).default(""),
    EMAIL_PROVIDER: z.enum(["brevo", "disabled"]).default("disabled"),
    ADMIN_OTP_TTL_MINUTES: z.coerce.number().int().min(5).max(30).default(10),
    ADMIN_CROSS_SITE_COOKIES: bool,
    VIRUSTOTAL_API_KEY: z.string().default(""),
  });

export function loadConfig(environment = process.env) {
  if (environment.DEVELOPMENT_DEMO === "true")
    throw new Error("Development demo mode is disabled. Configure the hosted backend instead.");
  const result = schema.safeParse(environment);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid environment configuration: ${details}`);
  }
  const config = result.data;
  if (config.ADMIN_CROSS_SITE_COOKIES && config.NODE_ENV !== "production")
    throw new Error("Cross-site administrator cookies require production HTTPS.");
  config.DEVELOPMENT_DEMO = false;
  config.allowedOrigins = [
    ...new Set([config.PUBLIC_ORIGIN, config.ADMIN_ORIGIN]),
  ];
  config.adminAllowedCountries = config.ADMIN_ALLOWED_COUNTRIES.split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  config.adminAllowedIps = config.ADMIN_ALLOWED_IPS.split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  return Object.freeze(config);
}
