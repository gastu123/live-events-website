import { Router } from "express";
import crypto from "node:crypto";
import { asyncRoute, HttpError, ok } from "../http.js";
import {
  credentials,
  parse,
  strongPassword,
} from "../schemas.js";

export function authRoutes({ auth, db, loginLimiter, mailer, config, csrfMiddleware }) {
  const router = Router();
  router.post(
    "/admin/login",
    loginLimiter,
    asyncRoute(async (req, res) => {
      auth.validateAdminNetwork(req);
      const input = parse(credentials, req.body);
      const { data, error } = await auth.anon.auth.signInWithPassword(input);
      let admin;
      if (!error && data.user)
        admin = (
          await db.query(
            "select id, status from admin_users where profile_id=$1 and deleted_at is null",
            [data.user.id],
          )
        ).rows[0];
      await db.query(
        "insert into admin_login_attempts (email_hash, succeeded, ip_address, user_agent, admin_user_id) values ($1,$2,$3,$4,$5)",
        [
          crypto
            .createHash("sha256")
            .update(input.email.toLowerCase())
            .digest("hex"),
          Boolean(admin && admin.status === "active"),
          req.ip,
          req.get("user-agent")?.slice(0, 500),
          admin?.id || null,
        ],
      );
      if (error || !data.session || !admin || admin.status !== "active")
        throw new HttpError(
          401,
          "ADMIN_LOGIN_FAILED",
          "Administrator credentials are incorrect.",
        );
      const csrfToken = auth.setSession(res, data.session, "admin");
      await db.query("update admin_users set last_login_at=now() where id=$1", [
        admin.id,
      ]);
      await db.query(
        "insert into audit_logs(admin_user_id, action, entity_type, entity_id, request_id, metadata) values($1,'admin.login','admin_user',$1,$2,'{}')",
        [admin.id, res.locals.requestId],
      );
      const bearerFallback = req.get("x-auth-transport") === "bearer-fallback";
      ok(res, {
        csrfToken,
        expiresIn: data.session.expires_in,
        ...(bearerFallback
          ? {
              accessToken: data.session.access_token,
              refreshToken: data.session.refresh_token,
            }
          : {}),
      });
    }),
  );
    const refresh = asyncRoute(async (req, res) => {
      const refreshToken = req.cookies.admin_refresh_token || String(req.body?.refreshToken || "");
      if (!refreshToken)
        throw new HttpError(
          401,
          "REFRESH_REQUIRED",
          "Refresh session is unavailable.",
        );
      const { data, error } = await auth.anon.auth.refreshSession({
        refresh_token: refreshToken,
      });
      if (error || !data.session)
        throw new HttpError(401, "REFRESH_FAILED", "Session refresh failed.");
      const bearerFallback = req.get("x-auth-transport") === "bearer-fallback";
      ok(res, {
        csrfToken: auth.setSession(res, data.session),
        ...(bearerFallback
          ? {
              accessToken: data.session.access_token,
              refreshToken: data.session.refresh_token,
            }
          : {}),
      });
    });
  router.post("/admin/refresh", refresh);
  const recoveryResponse = {
    accepted: true,
    message: "If the recovery details match an active administrator, a verification code will be sent.",
  };
  async function requestAdminOtp(req, res) {
    const email = zEmail(req.body?.email).toLowerCase();
    const ipHash = secretHash(config.COOKIE_SECRET, req.ip || "unknown");
    const limits = await db.query(
      "select count(*) ip_count from admin_password_otps where requested_ip_hash=$1 and created_at>now()-interval '1 hour'",
      [ipHash],
    );
    const maskedEmail = maskEmail(email);
    if (Number(limits.rows[0]?.ip_count || 0) >= 10)
      return ok(res, { ...recoveryResponse, maskedEmail }, 202);
    const admin = await findAdminByLoginEmail(auth, db, email);
    if (!admin) return ok(res, { ...recoveryResponse, maskedEmail }, 202);
    const accountLimits = await db.query(
      "select count(*) account_count from admin_password_otps where admin_user_id=$1 and created_at>now()-interval '1 hour'",
      [admin.id],
    );
    if (Number(accountLimits.rows[0]?.account_count || 0) >= 5)
      return ok(res, { ...recoveryResponse, maskedEmail }, 202);
    const latest = (
      await db.query(
        "select resend_available_at from admin_password_otps where admin_user_id=$1 order by created_at desc limit 1",
        [admin.id],
      )
    ).rows[0];
    if (latest && new Date(latest.resend_available_at) > new Date())
      return ok(res, { ...recoveryResponse, maskedEmail, retryAfterSeconds: 60 }, 202);
    const id = crypto.randomUUID();
    const otp = crypto.randomInt(0, 1_000_000).toString().padStart(6, "0");
    await db.query(
      "update admin_password_otps set used_at=coalesce(used_at,now()) where admin_user_id=$1 and used_at is null",
      [admin.id],
    );
    await db.query(
      `insert into admin_password_otps(id,admin_user_id,otp_hash,requested_ip_hash,expires_at,resend_available_at)
       values($1,$2,$3,$4,now()+($5::text||' minutes')::interval,now()+interval '60 seconds')`,
      [id, admin.id, secretHash(config.COOKIE_SECRET, `${id}:${otp}`), ipHash, config.ADMIN_OTP_TTL_MINUTES],
    );
    try {
      await mailer.sendAdminOtp({ to: admin.destination_email, otp, ttlMinutes: config.ADMIN_OTP_TTL_MINUTES });
    } catch {
      await db.query("update admin_password_otps set used_at=now() where id=$1", [id]);
    }
    return ok(res, { ...recoveryResponse, maskedEmail }, 202);
  }
  router.post("/admin/recovery/request", loginLimiter, asyncRoute(requestAdminOtp));
  router.post("/admin/recovery/resend", loginLimiter, asyncRoute(requestAdminOtp));
  router.post(
    "/admin/recovery/verify",
    loginLimiter,
    asyncRoute(async (req, res) => {
      const email = zEmail(req.body?.email).toLowerCase();
      const code = String(req.body?.code || "");
      if (!/^\d{6}$/.test(code)) throw recoveryError();
      const admin = await findAdminByLoginEmail(auth, db, email);
      if (!admin) throw recoveryError();
      const row = (
        await db.query(
          `select o.id,o.otp_hash,o.attempts,o.expires_at,o.admin_user_id
           from admin_password_otps o where o.admin_user_id=$1
             and o.used_at is null and o.verified_at is null order by o.created_at desc limit 1`,
          [admin.id],
        )
      ).rows[0];
      if (!row || row.attempts >= 5 || new Date(row.expires_at) <= new Date()) throw recoveryError();
      const valid = safeEqual(row.otp_hash, secretHash(config.COOKIE_SECRET, `${row.id}:${code}`));
      if (!valid) {
        await db.query("update admin_password_otps set attempts=least(5,attempts+1) where id=$1", [row.id]);
        throw recoveryError();
      }
      const resetToken = crypto.randomBytes(32).toString("base64url");
      await db.query(
        "update admin_password_otps set verified_at=now(),reset_token_hash=$2,reset_expires_at=now()+interval '10 minutes' where id=$1",
        [row.id, secretHash(config.COOKIE_SECRET, resetToken)],
      );
      ok(res, { verified: true, resetToken, maskedEmail: maskEmail(admin.destination_email) });
    }),
  );
  router.post(
    "/admin/recovery/reset",
    loginLimiter,
    asyncRoute(async (req, res) => {
      const email = zEmail(req.body?.email).toLowerCase();
      const password = parse(strongPassword, req.body?.newPassword);
      if (password !== req.body?.confirmPassword)
        throw new HttpError(400, "PASSWORD_MISMATCH", "Password confirmation does not match.");
      const tokenHash = secretHash(config.COOKIE_SECRET, String(req.body?.resetToken || ""));
      const admin = await findAdminByLoginEmail(auth, db, email);
      if (!admin) throw recoveryError();
      const row = (
        await db.query(
          `select o.id,o.admin_user_id,a.profile_id,a.recovery_email from admin_password_otps o
           join admin_users a on a.id=o.admin_user_id
           where o.admin_user_id=$1 and o.reset_token_hash=$2 and o.verified_at is not null
             and o.used_at is null and o.reset_expires_at>now() and a.status='active' and a.deleted_at is null
           order by o.created_at desc limit 1`,
          [admin.id, tokenHash],
        )
      ).rows[0];
      if (!row) throw recoveryError();
      const { error } = await auth.service.auth.admin.updateUserById(row.profile_id, { password });
      if (error) throw new HttpError(502, "PASSWORD_UPDATE_FAILED", "Password could not be updated.");
      await db.query("update admin_password_otps set used_at=now() where id=$1", [row.id]);
      await db.query("update admin_users set sessions_invalidated_at=date_trunc('second',now()),updated_at=now() where id=$1", [row.admin_user_id]);
      await db.query(
        "insert into audit_logs(admin_user_id,action,entity_type,entity_id,request_id,metadata) values($1,'admin.password_recovered','admin_user',$1,$2,'{}')",
        [row.admin_user_id, res.locals.requestId],
      );
      await mailer.sendPasswordChanged({ to: admin.destination_email }).catch(() => {});
      auth.clearSession(res, "admin");
      ok(res, { updated: true, sessionsRevoked: true });
    }),
  );
  router.post(
    "/admin/change-password",
    loginLimiter,
    csrfMiddleware,
    auth.requireAdmin(),
    asyncRoute(async (req, res) => {
      const currentPassword = String(req.body?.currentPassword || "");
      const newPassword = parse(strongPassword, req.body?.newPassword);
      if (newPassword !== req.body?.confirmPassword)
        throw new HttpError(400, "PASSWORD_MISMATCH", "Password confirmation does not match.");
      const { error: reauthError } = await auth.anon.auth.signInWithPassword({ email: req.user.email, password: currentPassword });
      if (reauthError) throw new HttpError(401, "REAUTHENTICATION_FAILED", "Current password is incorrect.");
      const { error } = await auth.service.auth.admin.updateUserById(req.user.id, { password: newPassword });
      if (error) throw new HttpError(502, "PASSWORD_UPDATE_FAILED", "Password could not be updated.");
      const recovery = (
        await db.query("update admin_users set sessions_invalidated_at=date_trunc('second',now()),updated_at=now() where id=$1 returning recovery_email", [req.admin.id])
      ).rows[0];
      await db.query(
        "insert into audit_logs(admin_user_id,action,entity_type,entity_id,request_id,metadata) values($1,'admin.password_changed','admin_user',$1,$2,'{}')",
        [req.admin.id, res.locals.requestId],
      );
      await auth.service.auth.admin.signOut(req.cookies.admin_access_token, "global").catch(() => {});
      await mailer.sendPasswordChanged({ to: recovery?.recovery_email }).catch(() => {});
      auth.clearSession(res, "admin");
      ok(res, { updated: true, sessionsRevoked: true });
    }),
  );
  const logout = asyncRoute(async (req, res) => {
      const accessToken = req.cookies.admin_access_token || req.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
      if (accessToken)
        await auth.service.auth.admin.signOut(accessToken).catch(() => {});
      auth.clearSession(res);
      res.set("Clear-Site-Data", '"cache"');
      ok(res, { loggedOut: true });
    });
  router.post("/admin/logout", logout);
  return router;
}
function secretHash(secret, value) {
  return crypto.createHmac("sha256", secret).update(value).digest("hex");
}
function safeEqual(left, right) {
  try { return crypto.timingSafeEqual(Buffer.from(left), Buffer.from(right)); } catch { return false; }
}
function maskEmail(email) {
  const [name, domain = ""] = email.split("@");
  if (name.length <= 2) return `${name.slice(0, 1)}***@${domain}`;
  const visibleTail = name.slice(-Math.min(3, name.length - 1));
  return `${name[0]}${"*".repeat(Math.max(3, name.length - visibleTail.length - 1))}${visibleTail}@${domain}`;
}
function recoveryError() {
  return new HttpError(400, "RECOVERY_VERIFICATION_FAILED", "The verification code or reset session is invalid or expired.");
}
async function findAdminByLoginEmail(auth, db, email) {
  let user;
  for (let page = 1; page <= 20 && !user; page += 1) {
    const { data, error } = await auth.service.auth.admin.listUsers({ page, perPage: 100 });
    if (error) return null;
    user = data.users.find((candidate) => candidate.email?.toLowerCase() === email);
    if (data.users.length < 100) break;
  }
  if (!user) return null;
  const admin = (
    await db.query(
      "select id,coalesce(recovery_email,$2) destination_email from admin_users where profile_id=$1 and status='active' and deleted_at is null",
      [user.id, user.email],
    )
  ).rows[0];
  return admin || null;
}
function zEmail(value) {
  const result = credentials.shape.email.safeParse(value);
  if (!result.success)
    throw new HttpError(400, "VALIDATION_ERROR", "A valid email is required.");
  return result.data;
}
