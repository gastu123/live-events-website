import crypto from "node:crypto";

export class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    Object.assign(this, { status, code, details });
  }
}

export const asyncRoute = (handler) => (req, res, next) =>
  Promise.resolve(handler(req, res, next)).catch(next);
export const ok = (res, data, status = 200) =>
  res
    .status(status)
    .json({ success: true, data, requestId: res.locals.requestId });

export function requestId(req, res, next) {
  res.locals.requestId =
    req.get("x-request-id")?.slice(0, 100) || crypto.randomUUID();
  res.set("x-request-id", res.locals.requestId);
  next();
}

export function csrf(req, _res, next) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  const adminRoute = req.path.startsWith("/admin") || req.path.startsWith("/auth/admin");
  const accessCookie = adminRoute ? "admin_access_token" : "customer_access_token";
  const csrfCookie = adminRoute ? "admin_csrf" : "customer_csrf";
  if (!req.cookies[accessCookie]) return next();
  const token = req.get("x-csrf-token");
  if (!token || token !== req.cookies[csrfCookie])
    return next(new HttpError(403, "CSRF_INVALID", "Invalid CSRF token."));
  next();
}

export function notFound(req, _res, next) {
  next(
    new HttpError(
      404,
      "NOT_FOUND",
      `Route ${req.method} ${req.path} was not found.`,
    ),
  );
}
export function errorHandler(error, req, res, _next) {
  const status = error.status || (error.code === "23505" ? 409 : 500);
  req.log?.error(
    { err: error, requestId: res.locals.requestId },
    "request failed",
  );
  res.status(status).json({
    success: false,
    error: {
      code:
        error.code === "23505"
          ? "DUPLICATE_RECORD"
          : error.code || "INTERNAL_ERROR",
      message:
        error.code === "23505"
          ? "That reference or evidence has already been used."
          : status === 500
            ? "An unexpected error occurred."
            : error.message,
      ...(error.details ? { details: error.details } : {}),
    },
    requestId: res.locals.requestId,
  });
}
