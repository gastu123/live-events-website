import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { HttpError } from "./http.js";

const cookieOptions = (config) => ({
  httpOnly: true,
  secure: config.NODE_ENV === "production" || config.ADMIN_CROSS_SITE_COOKIES,
  sameSite: config.ADMIN_CROSS_SITE_COOKIES ? "none" : "strict",
  path: "/",
  maxAge: 60 * 60 * 1000,
});
export function createAuth(config, db) {
  const anon = createClient(config.SUPABASE_URL, config.SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const service = createClient(
    config.SUPABASE_URL,
    config.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
  const cookieNames = (kind) => kind === "admin"
    ? { access: "admin_access_token", refresh: "admin_refresh_token", csrf: "admin_csrf" }
    : { access: "customer_access_token", refresh: "customer_refresh_token", csrf: "customer_csrf" };
  const setSession = (res, session, kind = "customer") => {
    const names = cookieNames(kind);
    res.cookie(names.access, session.access_token, cookieOptions(config));
    res.cookie(names.refresh, session.refresh_token, {
      ...cookieOptions(config),
      maxAge: 30 * 86400000,
    });
    const csrfToken = crypto.randomBytes(24).toString("base64url");
    res.cookie(names.csrf, csrfToken, {
      secure: config.NODE_ENV === "production" || config.ADMIN_CROSS_SITE_COOKIES,
      sameSite: config.ADMIN_CROSS_SITE_COOKIES ? "none" : "strict",
      path: "/",
      maxAge: 30 * 86400000,
    });
    return csrfToken;
  };
  const clearSession = (res, kind = "customer") => {
    const names = cookieNames(kind);
    [names.access, names.refresh, names.csrf].forEach((name) =>
      res.clearCookie(name, {
        path: "/",
        secure: config.NODE_ENV === "production" || config.ADMIN_CROSS_SITE_COOKIES,
        sameSite: config.ADMIN_CROSS_SITE_COOKIES ? "none" : "strict",
      }),
    );
  };
  const validateAdminNetwork = (req) => {
    const country = req.get("cf-ipcountry")?.toUpperCase();
    if (
      config.adminAllowedCountries.length &&
      (!country || !config.adminAllowedCountries.includes(country))
    )
      throw new HttpError(
        403,
        "ADMIN_COUNTRY_RESTRICTED",
        "Administrator access is not allowed from this country.",
      );
    if (
      config.adminAllowedIps.length &&
      !config.adminAllowedIps.includes(req.ip)
    )
      throw new HttpError(
        403,
        "ADMIN_IP_RESTRICTED",
        "Administrator access is not allowed from this network.",
      );
  };
  const requireUser = async (req, _res, next) => {
    try {
      const token = req.cookies.customer_access_token;
      if (!token)
        throw new HttpError(401, "AUTH_REQUIRED", "Authentication required.");
      const { data, error } = await service.auth.getUser(token);
      if (error || !data.user)
        throw new HttpError(
          401,
          "SESSION_INVALID",
          "Session is invalid or expired.",
        );
      req.user = data.user;
      next();
    } catch (error) {
      next(error);
    }
  };
  const requireAdmin =
    (permissions = []) =>
    async (req, _res, next) => {
      try {
        validateAdminNetwork(req);
        const token = req.cookies.admin_access_token;
        if (!token)
          throw new HttpError(401, "AUTH_REQUIRED", "Authentication required.");
        const { data: user, error } = await service.auth.getUser(token);
        if (error || !user?.user)
          throw new HttpError(401, "SESSION_INVALID", "Session is invalid or expired.");
        req.user = user.user;
        const result = await db.query(
          `select au.id, au.is_super_admin, au.status, au.sessions_invalidated_at, ar.name role,
        coalesce(array_agg(ap.code) filter (where ap.code is not null), '{}') permissions
        from admin_users au join admin_roles ar on ar.id=au.role_id
        left join admin_role_permissions arp on arp.role_id=ar.id left join admin_permissions ap on ap.id=arp.permission_id
        where au.profile_id=$1 and au.deleted_at is null group by au.id, ar.name`,
          [req.user.id],
        );
        const admin = result.rows[0];
        if (!admin || admin.status !== "active")
          throw new HttpError(
            403,
            "ADMIN_REQUIRED",
            "Administrator access required.",
          );
        const issuedAt = Number(req.user?.iat || decodeJwtIssuedAt(req.cookies.admin_access_token));
        if (
          admin.sessions_invalidated_at &&
          (!issuedAt || issuedAt * 1000 < new Date(admin.sessions_invalidated_at).getTime())
        )
          throw new HttpError(401, "SESSION_REVOKED", "Session was revoked. Sign in again.");
        if (
          permissions.some(
            (permission) =>
              !admin.is_super_admin && !admin.permissions.includes(permission),
          )
        )
          throw new HttpError(
            403,
            "FORBIDDEN",
            "Your role does not allow this action.",
          );
        req.admin = admin;
        next();
      } catch (error) {
        next(error);
      }
    };
  return {
    anon,
    service,
    setSession,
    clearSession,
    requireUser,
    requireAdmin,
    validateAdminNetwork,
  };
}

function decodeJwtIssuedAt(token) {
  try {
    return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()).iat;
  } catch {
    return 0;
  }
}
