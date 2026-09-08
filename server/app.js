import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import cookieParser from "cookie-parser";
import cors from "cors";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import { createAuth } from "./auth.js";
import { csrf, errorHandler, notFound, ok, requestId } from "./http.js";
import { adminRoutes } from "./routes/admin.js";
import { authRoutes } from "./routes/auth.js";
import { publicRoutes } from "./routes/public.js";
import { createBrevoMailer } from "./email/brevo.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicRoot = path.join(root, "public-site");
const adminRoot = path.join(root, "admin-site");
export function createApp({ config, db, logger, services = {} }) {
  const app = express();
  if (config.TRUST_PROXY) app.set("trust proxy", 1);
  app.disable("x-powered-by");
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "https://fonts.googleapis.com"],
          fontSrc: ["'self'", "https://fonts.gstatic.com"],
          imgSrc: ["'self'", "data:", "https:"],
          connectSrc: ["'self'", config.SUPABASE_URL],
          frameSrc: ["'self'"],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
        },
      },
    }),
  );
  app.use(
    cors({
      origin(origin, callback) {
        if (!origin || config.allowedOrigins.includes(origin))
          return callback(null, true);
        const error = new Error("Origin not allowed");
        error.status = 403;
        error.code = "CORS_ORIGIN_DENIED";
        callback(error);
      },
      credentials: true,
      methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: [
        "Content-Type",
        "X-CSRF-Token",
        "X-Auth-Transport",
        "Authorization",
        "Idempotency-Key",
        "X-Request-ID",
      ],
    }),
  );
  app.use(requestId);
  app.use((req, res, next) => {
    req.log = logger.child({
      requestId: res.locals.requestId,
      method: req.method,
      path: req.path,
    });
    const start = Date.now();
    res.on("finish", () =>
      req.log.info(
        { status: res.statusCode, durationMs: Date.now() - start },
        "request complete",
      ),
    );
    next();
  });
  app.use(
    express.json({
      limit: "100kb",
    }),
  );
  app.use(express.urlencoded({ extended: false, limit: "20kb" }));
  app.use(cookieParser(config.COOKIE_SECRET));
  const auth = services.auth || createAuth(config, db);
  const mailer = services.mailer || createBrevoMailer(config);
  const standard = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 150,
    standardHeaders: "draft-8",
    legacyHeaders: false,
  });
  const publicLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 20,
    standardHeaders: "draft-8",
    legacyHeaders: false,
  });
  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 8,
    standardHeaders: "draft-8",
    legacyHeaders: false,
  });
  app.get("/api/v1/health", (_req, res) =>
    ok(res, { status: "ok", timestamp: new Date().toISOString() }),
  );
  app.use("/api/v1/auth", authRoutes({ auth, db, loginLimiter, mailer, config, csrfMiddleware: csrf }));
  app.use(
    "/api/v1",
    standard,
    csrf,
    publicRoutes({ db, auth, publicLimiter, config }),
  );
  app.use("/api/v1/admin", standard, adminRoutes({ db, auth, config }));
  app.get("/admin.html", (_req, res) => {
    res.set("X-Robots-Tag", "noindex, nofollow, noarchive");
    res.redirect(302, "/admin-site/");
  });
  app.use(
    "/admin-site",
    express.static(adminRoot, {
      extensions: ["html"],
      setHeaders(res, file) {
        if (file.endsWith(".html")) res.set("X-Robots-Tag", "noindex, nofollow, noarchive");
      },
    }),
  );
  app.use(express.static(publicRoot, { extensions: ["html"] }));
  app.use(notFound);
  app.use(errorHandler);
  return app;
}
