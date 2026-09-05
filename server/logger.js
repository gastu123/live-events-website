import pino from "pino";

export function createLogger(level = "info") {
  return pino({
    level,
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers.cookie",
        "password",
        "refresh_token",
        "access_token",
        "email",
        "phone",
        "*.password",
        "*.email",
        "*.phone",
      ],
      censor: "[REDACTED]",
    },
  });
}
