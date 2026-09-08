import { Router } from "express";
import crypto from "node:crypto";
import { asyncRoute, HttpError, ok } from "../http.js";
import { eventInput, eventWithSectionInput, parse, phoneCountry, recoveryPhone, sectionInput, strongPassword, uuid } from "../schemas.js";

const audit = (client, req, action, type, id, metadata = {}) =>
  client.query(
    "insert into audit_logs(admin_user_id,action,entity_type,entity_id,request_id,reason,metadata) values($1,$2,$3,$4,$5,$6,$7)",
    [
      req.admin.id,
      action,
      type,
      id,
      resId(req),
      metadata.reason || null,
      metadata,
    ],
  );
const resId = (req) => req.res.locals.requestId;
export function adminRoutes({ db, auth, config }) {
  const r = Router();
  r.use(auth.requireAdmin());
  const rolePermissions = async (roleId) =>
    (await db.query(
      "select p.code from admin_role_permissions rp join admin_permissions p on p.id=rp.permission_id where rp.role_id=$1 order by p.code",
      [roleId],
    )).rows.map((row) => row.code);
  const ensureGrantable = async (req, roleId) => {
    const codes = await rolePermissions(roleId);
    if (!req.admin.is_super_admin && codes.some((code) => !req.admin.permissions.includes(code)))
      throw new HttpError(403, "PERMISSION_ESCALATION_DENIED", "You cannot grant permissions you do not possess.");
    return codes;
  };
  const dialCodes = { NG: "234", US: "1", GB: "44", CA: "1" };
  const normalizeAdminPhone = (value, country) => {
    if (!value) return null;
    const phone = parse(recoveryPhone, value);
    if (phone.startsWith("+")) return phone;
    if (country === "OTHER") return phone;
    const code = dialCodes[country];
    if (!code) throw new HttpError(400, "PHONE_COUNTRY_REQUIRED", "Select the phone country when entering a local phone number.");
    return `+${code}${phone.replace(/^0/, "")}`;
  };
  r.get(
    "/overview",
    asyncRoute(async (_req, res) => {
      const x = (
        await db.query(
          `select (select count(*) from orders where status in ('pending_payment','awaiting_payment_details','payment_details_ready','pending_verification')) pending_orders,(select count(*) from payments where status in ('awaiting_payment_details','payment_details_expired','payment_details_ready','pending_verification')) pending_payments,(select count(*) from payments where status='successful') successful_payments,(select count(*) from membership_applications where status in ('pending','on_hold')) pending_applications,(select count(*) from service_requests where status not in ('archived','resolved')) open_services`,
        )
      ).rows[0];
      ok(res, x);
    }),
  );
  r.get(
    "/events",
    asyncRoute(async (_req, res) =>
      ok(
        res,
        (
          await db.query(
            "select * from events where deleted_at is null order by starts_at desc",
          )
        ).rows,
      ),
    ),
  );
  r.get(
    "/events/:id/sections",
    auth.requireAdmin(["inventory.write"]),
    asyncRoute(async (req, res) => {
      uuid.parse(req.params.id);
      ok(
        res,
        (
          await db.query(
            "select es.id,es.name,es.description,es.price_minor,ti.available_quantity,ti.held_quantity,ti.sold_quantity,greatest(ti.available_quantity-ti.held_quantity-ti.sold_quantity,0) remaining_quantity from event_sections es join ticket_inventory ti on ti.section_id=es.id where es.event_id=$1 and es.deleted_at is null order by es.price_minor",
            [req.params.id],
          )
        ).rows,
      );
    }),
  );
  r.post(
    "/events",
    auth.requireAdmin(["events.write"]),
    asyncRoute(async (req, res) => {
      const i = parse(eventWithSectionInput, req.body);
      const slug = `${i.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")}-${Date.now().toString(36)}`;
      const row = await db.transaction(async (client) => {
        const event = (
          await client.query(
            "insert into events(title,slug,description,venue,city,country,starts_at,currency,status,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,'published',$9) returning *",
            [
              i.title,
              slug,
              i.description,
              i.venue,
              i.city,
              i.country,
              i.startsAt,
              i.currency,
              req.admin.id,
            ],
          )
        ).rows[0];
        await audit(client, req, "event.create", "event", event.id);
        const section = (
          await client.query(
            "insert into event_sections(event_id,name,description,price_minor) values($1,$2,$3,$4) returning *",
            [
              event.id,
              i.section.name,
              i.section.description,
              i.section.priceMinor,
            ],
          )
        ).rows[0];
        await client.query(
          "insert into ticket_inventory(section_id,available_quantity,held_quantity,sold_quantity) values($1,$2,0,0)",
          [section.id, i.section.availableQuantity],
        );
        await audit(client, req, "inventory.create", "event_section", section.id);
        return event;
      });
      ok(res, row, 201);
    }),
  );
  r.patch(
    "/events/:id",
    auth.requireAdmin(["events.write"]),
    asyncRoute(async (req, res) => {
      uuid.parse(req.params.id);
      const i = parse(eventInput.partial(), req.body);
      const row = (
        await db.query(
          `update events set title=coalesce($2,title),description=coalesce($3,description),venue=coalesce($4,venue),city=coalesce($5,city),country=coalesce($6,country),starts_at=coalesce($7,starts_at),currency=coalesce($8,currency),updated_at=now() where id=$1 and deleted_at is null returning *`,
          [
            req.params.id,
            i.title,
            i.description,
            i.venue,
            i.city,
            i.country,
            i.startsAt,
            i.currency,
          ],
        )
      ).rows[0];
      if (!row) throw new HttpError(404, "EVENT_NOT_FOUND", "Event not found.");
      await audit(db, req, "event.update", "event", row.id);
      ok(res, row);
    }),
  );
  r.post(
    "/events/:id/status",
    auth.requireAdmin(["events.publish"]),
    asyncRoute(async (req, res) => {
      uuid.parse(req.params.id);
      const status = parse(
        (await import("zod")).z.object({
          status: (await import("zod")).z.enum([
            "published",
            "unpublished",
            "archived",
          ]),
        }),
        req.body,
      ).status;
      const row = (
        await db.query(
          "update events set status=$2,updated_at=now() where id=$1 and deleted_at is null returning *",
          [req.params.id, status],
        )
      ).rows[0];
      if (!row) throw new HttpError(404, "EVENT_NOT_FOUND", "Event not found.");
      await audit(db, req, `event.${status}`, "event", row.id);
      ok(res, row);
    }),
  );
  r.delete(
    "/events/:id",
    auth.requireAdmin(["events.write"]),
    asyncRoute(async (req, res) => {
      uuid.parse(req.params.id);
      const event = await db.transaction(async (client) => {
        const current = (
          await client.query(
            "select id,title from events where id=$1 and deleted_at is null for update",
            [req.params.id],
          )
        ).rows[0];
        if (!current)
          throw new HttpError(404, "EVENT_NOT_FOUND", "Event not found.");
        await client.query(
          "update events set status='archived',deleted_at=now(),updated_at=now() where id=$1",
          [current.id],
        );
        await audit(client, req, "event.archive", "event", current.id, {
          reason: "Archived from the administrator event manager",
        });
        return current;
      });
      ok(res, { archived: true, id: event.id });
    }),
  );
  r.post(
    "/events/:id/sections",
    auth.requireAdmin(["inventory.write"]),
    asyncRoute(async (req, res) => {
      uuid.parse(req.params.id);
      const i = parse(sectionInput, req.body);
      const row = await db.transaction(async (c) => {
        const s = (
          await c.query(
            "insert into event_sections(event_id,name,description,price_minor) values($1,$2,$3,$4) returning *",
            [req.params.id, i.name, i.description, i.priceMinor],
          )
        ).rows[0];
        await c.query(
          "insert into ticket_inventory(section_id,available_quantity,held_quantity,sold_quantity) values($1,$2,0,0)",
          [s.id, i.availableQuantity],
        );
        await audit(c, req, "inventory.create", "event_section", s.id);
        return s;
      });
      ok(res, row, 201);
    }),
  );
  r.patch(
    "/sections/:id/inventory",
    auth.requireAdmin(["inventory.write"]),
    asyncRoute(async (req, res) => {
      uuid.parse(req.params.id);
      const i = parse(
        sectionInput
          .pick({
            description: true,
            priceMinor: true,
            availableQuantity: true,
          })
          .partial(),
        req.body,
      );
      const row = await db.transaction(async (c) => {
        const current = (
          await c.query(
            "select * from ticket_inventory where section_id=$1 for update",
            [req.params.id],
          )
        ).rows[0];
        if (!current)
          throw new HttpError(404, "SECTION_NOT_FOUND", "Section not found.");
        if (
          i.availableQuantity !== undefined &&
          i.availableQuantity < current.held_quantity + current.sold_quantity
        )
          throw new HttpError(
            409,
            "INVENTORY_BELOW_COMMITTED",
            "Inventory cannot be lower than held and sold quantities.",
          );
        if (i.priceMinor !== undefined || i.description !== undefined)
          await c.query(
            "update event_sections set price_minor=coalesce($2,price_minor),description=coalesce($3,description),updated_at=now() where id=$1",
            [req.params.id, i.priceMinor, i.description],
          );
        const inv = (
          await c.query(
            "update ticket_inventory set available_quantity=coalesce($2,available_quantity),updated_at=now() where section_id=$1 returning *",
            [req.params.id, i.availableQuantity],
          )
        ).rows[0];
        await audit(c, req, "inventory.update", "event_section", req.params.id);
        return inv;
      });
      ok(res, row);
    }),
  );
  r.get(
    "/orders",
    auth.requireAdmin(["orders.read"]),
    asyncRoute(async (_req, res) =>
      ok(
        res,
        (
          await db.query(
            `select o.id,o.reference,o.status,o.payment_status,o.total_minor,o.currency,o.contact_name,o.contact_email,o.created_at,e.title event_title,pa.method payment_method,coalesce(sum(oi.quantity),0)::int quantity from orders o join events e on e.id=o.event_id left join order_items oi on oi.order_id=o.id left join lateral(select method from payments where order_id=o.id order by created_at desc limit 1) pa on true group by o.id,e.title,pa.method order by o.created_at desc`,
          )
        ).rows,
      ),
    ),
  );
  r.get(
    "/payments",
    auth.requireAdmin(["payments.read"]),
    asyncRoute(async (_req, res) =>
      ok(
        res,
        (
          await db.query(
            `select p.*,o.reference order_reference,o.contact_name,o.contact_email,o.status order_status,
                    pa.id assignment_id,pa.status assignment_status,pa.expires_at assignment_expires_at
             from payments p join orders o on o.id=p.order_id
             left join lateral(select id,status,expires_at from payment_assignments where payment_id=p.id order by created_at desc limit 1) pa on true
             order by p.created_at desc`,
          )
        ).rows,
      ),
    ),
  );
  r.post(
    "/payments/:id/confirm",
    auth.requireAdmin(["payments.verify"]),
    asyncRoute(async (req, res) => {
      uuid.parse(req.params.id);
      const reason = String(req.body?.reason || "").trim();
      if (reason.length < 5 || reason.length > 1000)
        throw new HttpError(
          400,
          "REASON_REQUIRED",
          "A confirmation reason of at least 5 characters is required.",
        );
      const confirmedAmountMinor = Number(req.body?.confirmedAmountMinor);
      const confirmedCurrency = String(
        req.body?.confirmedCurrency || "",
      ).toUpperCase();
      const result = await db.transaction(async (c) => {
        const p = (
          await c.query("select * from payments where id=$1 for update", [
            req.params.id,
          ])
        ).rows[0];
        if (!p)
          throw new HttpError(404, "PAYMENT_NOT_FOUND", "Payment not found.");
        if (p.status === "successful") return p;
        const manual =
          p.provider === "manual" &&
          ["paypal", "cash_app", "chime", "bank_transfer", "gift_card"].includes(p.method);
        if (
          manual &&
          (!Number.isInteger(confirmedAmountMinor) ||
            confirmedAmountMinor !== Number(p.amount_minor) ||
            confirmedCurrency !== p.currency)
        )
          throw new HttpError(
            409,
            "MANUAL_PAYMENT_MISMATCH",
            "The confirmed business-account amount or currency does not match the payment record.",
          );
        if (
          !manual ||
          p.status !== "pending_verification"
        )
          throw new HttpError(
            409,
            "PAYMENT_STATE_INVALID",
            "Payment cannot be confirmed in its current state.",
          );
        const updated = (
          await c.query(
            "update payments set status='successful',verified_at=coalesce(verified_at,now()),verified_by=$2,verification_source='admin_receiving_account_check',updated_at=now() where id=$1 returning *",
            [p.id, req.admin.id],
          )
        ).rows[0];
        await c.query(
          "update orders set payment_status='successful',status='payment_successful',updated_at=now() where id=$1",
          [p.order_id],
        );
        await c.query(
          `update ticket_inventory ti set held_quantity=greatest(0,ti.held_quantity-oi.quantity),sold_quantity=ti.sold_quantity+oi.quantity,updated_at=now() from order_items oi where oi.order_id=$1 and ti.section_id=oi.event_section_id`,
          [p.order_id],
        );
        await c.query(
          "update payment_assignments set status='completed',updated_at=now() where payment_id=$1 and status='submitted'",
          [p.id],
        );
        const order = (
          await c.query(
            "select id,profile_id from orders where id=$1",
            [p.order_id],
          )
        ).rows[0];
        if (order?.profile_id) {
          const application = (
            await c.query(
              "select * from membership_applications where profile_id=$1 and status in ('pending','on_hold') order by created_at desc limit 1 for update",
              [order.profile_id],
            )
          ).rows[0];
          if (application) {
            await c.query(
              "update membership_applications set status='approved',reviewed_by=$2,reviewed_at=now(),updated_at=now() where id=$1 returning *",
              [application.id, req.admin.id],
            );
            await c.query(
              "insert into memberships(profile_id,application_id,status,starts_at,expires_at) values($1,$2,'active',now(),now()+interval '1 year') on conflict(application_id) do update set status='active',starts_at=now(),expires_at=now()+interval '1 year',updated_at=now()",
              [application.profile_id, application.id],
            );
            await c.query(
              "insert into notifications(profile_id,kind,title,body) values($1,$2,$3,$4)",
              [
                application.profile_id,
                "membership_approved",
                "Membership approved",
                "Your membership application was approved. Your membership is now active.",
              ],
            );
          }
        }
        await c.query(
          "insert into notifications(profile_id,kind,title,body) select profile_id,'payment_successful','Payment successful','Your payment has been confirmed by an administrator.' from orders where id=$1 and profile_id is not null",
          [p.order_id],
        );
        await audit(
          c,
          req,
          "payment.manual_confirm",
          "payment",
          p.id,
          {
            reason,
          },
        );
        return updated;
      });
      ok(res, {
        payment: result,
        message: "Payment successful. Your payment has been confirmed.",
      });
    }),
  );
  r.post(
    "/payments/:id/reject",
    auth.requireAdmin(["payments.verify"]),
    asyncRoute(async (req, res) => {
      uuid.parse(req.params.id);
      const reason = String(req.body?.reason || "").trim();
      if (reason.length < 5)
        throw new HttpError(
          400,
          "REASON_REQUIRED",
          "A rejection reason is required.",
        );
      const row = await db.transaction(async (c) => {
        const p = (
          await c.query("select * from payments where id=$1 for update", [
            req.params.id,
          ])
        ).rows[0];
        if (!p)
          throw new HttpError(404, "PAYMENT_NOT_FOUND", "Payment not found.");
        if (
          p.provider !== "manual" ||
          ![
            "awaiting_payment_details",
            "payment_details_ready",
            "pending_verification",
          ].includes(p.status)
        )
          throw new HttpError(
            409,
            "PAYMENT_STATE_INVALID",
            "Payment cannot be rejected in its current state.",
          );
        const u = (
          await c.query(
            "update payments set status='rejected',failure_reason=$2,updated_at=now() where id=$1 returning *",
            [p.id, reason],
          )
        ).rows[0];
        await c.query(
          "update orders set payment_status='rejected',status='payment_rejected',updated_at=now() where id=$1",
          [p.order_id],
        );
        await c.query(
          "update ticket_inventory ti set held_quantity=greatest(0,ti.held_quantity-oi.quantity),updated_at=now() from order_items oi where oi.order_id=$1 and ti.section_id=oi.event_section_id",
          [p.order_id],
        );
        await c.query(
          "update payment_assignments set status='rejected',updated_at=now() where payment_id=$1 and status in ('active','submitted')",
          [p.id],
        );
        await c.query(
          "insert into notifications(profile_id,kind,title,body) select profile_id,'payment_rejected','Payment not approved','Your payment could not be approved. Review your payment details or contact support.' from orders where id=$1 and profile_id is not null",
          [p.order_id],
        );
        await audit(c, req, "payment.manual_reject", "payment", p.id, {
          reason,
        });
        return u;
      });
      ok(res, row);
    }),
  );
  r.get(
    "/membership-applications",
    auth.requireAdmin(["memberships.read"]),
    asyncRoute(async (_req, res) =>
      ok(
        res,
        (
          await db.query(
            "select * from membership_applications order by created_at desc",
          )
        ).rows,
      ),
    ),
  );
  r.post(
    "/membership-applications/:id/decision",
    auth.requireAdmin(["memberships.write"]),
    asyncRoute(async (req, res) => {
      uuid.parse(req.params.id);
      const decision = String(req.body?.decision);
      if (!["approved", "declined", "on_hold"].includes(decision))
        throw new HttpError(400, "DECISION_INVALID", "Decision is invalid.");
      const notes = String(req.body?.notes || "").trim();
      const storedNotes = notes ? notes.slice(0, 5000) : null;
      const row = await db.transaction(async (c) => {
        const a = (
          await c.query(
            "update membership_applications set status=$2,internal_notes=$3,reviewed_by=$4,reviewed_at=now(),updated_at=now() where id=$1 and status in ('pending','on_hold') returning *",
            [req.params.id, decision, storedNotes, req.admin.id],
          )
        ).rows[0];
        if (!a)
          throw new HttpError(
            404,
            "APPLICATION_NOT_FOUND",
            "Application not found.",
          );
        if (decision === "approved") {
          if (!a.profile_id)
            throw new HttpError(
              409,
              "APPLICATION_NOT_LINKED",
              "This application is not connected to a customer account.",
            );
          await c.query(
            `insert into memberships(profile_id,application_id,status,starts_at,expires_at)
             values($1,$2,'active',now(),now()+interval '1 year')
             on conflict(application_id) do update set status='active',starts_at=now(),expires_at=now()+interval '1 year',updated_at=now()`,
            [a.profile_id, a.id],
          );
        }
        if (a.profile_id) {
          const notification = {
            approved: ["Membership approved", "Your membership application was approved. Your membership is now active."],
            declined: ["Membership application declined", "Your membership application was declined."],
            on_hold: ["Membership application on hold", "Your membership application is on hold while it is reviewed."],
          }[decision];
          await c.query(
            "insert into notifications(profile_id,kind,title,body) values($1,$2,$3,$4)",
            [a.profile_id, `membership_${decision}`, ...notification],
          );
        }
        await audit(
          c,
          req,
          `membership.${decision}`,
          "membership_application",
          a.id,
          storedNotes ? { reason: storedNotes } : {},
        );
        return a;
      });
      ok(res, row);
    }),
  );
  r.get(
    "/service-requests",
    auth.requireAdmin(["services.read"]),
    asyncRoute(async (_req, res) =>
      ok(
        res,
        (
          await db.query(
            "select * from service_requests where archived_at is null order by created_at desc",
          )
        ).rows,
      ),
    ),
  );
  r.patch(
    "/service-requests/:id",
    auth.requireAdmin(["services.write"]),
    asyncRoute(async (req, res) => {
      uuid.parse(req.params.id);
      const status = String(req.body?.status || "");
      if (
        ![
          "new",
          "assigned",
          "in_progress",
          "waiting_customer",
          "resolved",
          "archived",
        ].includes(status)
      )
        throw new HttpError(400, "STATUS_INVALID", "Status is invalid.");
      const row = (
        await db.query(
          "update service_requests set status=$2,assigned_to=coalesce($3,assigned_to),internal_notes=coalesce($4,internal_notes),reply_draft=coalesce($5,reply_draft),archived_at=case when $2='archived' then now() else archived_at end,updated_at=now() where id=$1 returning *",
          [
            req.params.id,
            status,
            req.body.assignedTo || null,
            req.body.internalNotes || null,
            req.body.replyDraft || null,
          ],
        )
      ).rows[0];
      await audit(db, req, "service.update", "service_request", row.id);
      ok(res, row);
    }),
  );
  r.get(
    "/roles",
    auth.requireAdmin(["admins.manage"]),
    asyncRoute(async (_req, res) =>
      ok(
        res,
        (
          await db.query(
            `select r.id,r.name,r.description,
              coalesce(array_agg(p.code order by p.code) filter(where p.code is not null),'{}') permissions
             from admin_roles r left join admin_role_permissions rp on rp.role_id=r.id
             left join admin_permissions p on p.id=rp.permission_id group by r.id order by r.name`,
          )
        ).rows,
      ),
    ),
  );
  r.post(
    "/admins/invite",
    auth.requireAdmin(["admins.manage"]),
    asyncRoute(async (req, res) => {
      const email = String(req.body?.email || "")
        .trim()
        .toLowerCase();
      const fullName = String(req.body?.fullName || "").trim();
      const passwordResult = strongPassword.safeParse(String(req.body?.password || ""));
      const confirmPassword = String(req.body?.confirmPassword || "");
      const recoveryEmailValue = String(req.body?.recoveryEmail || "").trim().toLowerCase();
      const recoveryEmail = recoveryEmailValue || null;
      const recoveryPhoneValue = String(req.body?.recoveryPhone || "").trim();
      const recoveryCountryValue = String(req.body?.recoveryPhoneCountry || "").trim().toUpperCase();
      const recoveryCountryName = String(req.body?.recoveryPhoneCountryName || "").trim();
      const phone = recoveryPhoneValue ? normalizeAdminPhone(recoveryPhoneValue, recoveryCountryValue) : null;
      if (!/^\S+@\S+\.\S+$/.test(email)) throw new HttpError(400, "ADMIN_EMAIL_INVALID", "Enter a valid Admin email address.");
      if (fullName.length < 2) throw new HttpError(400, "ADMIN_NAME_INVALID", "Enter the Admin's full name.");
      if (!passwordResult.success) throw new HttpError(400, "ADMIN_PASSWORD_INVALID", "Password must be at least 8 characters and include at least one letter and one number.");
      if (passwordResult.data !== confirmPassword) throw new HttpError(400, "ADMIN_PASSWORD_MISMATCH", "Password and Confirm Password must match.");
      try { uuid.parse(req.body?.roleId); } catch { throw new HttpError(400, "ADMIN_ROLE_INVALID", "Select a valid Admin role."); }
      if (recoveryEmail && !/^\S+@\S+\.\S+$/.test(recoveryEmail))
        throw new HttpError(400, "RECOVERY_EMAIL_INVALID", "Recovery email is invalid.");
      if (recoveryPhoneValue) {
        parse(phoneCountry, recoveryCountryValue);
        if (recoveryCountryValue === "OTHER" && recoveryCountryName.length < 2)
          throw new HttpError(400, "PHONE_COUNTRY_REQUIRED", "Enter the recovery phone country.");
      }
      const role = (
        await db.query("select id,name from admin_roles where id=$1", [
          req.body.roleId,
        ])
      ).rows[0];
      if (!role || role.name === "Super Administrator")
        throw new HttpError(
          400,
          "ROLE_INVALID",
          "Invitations cannot grant the protected Super Administrator role.",
        );
      await ensureGrantable(req, role.id);
      let user;
      let createdAuthUser = false;
      for (let page = 1; page <= 20 && !user; page += 1) {
        const listed = await auth.service.auth.admin.listUsers({ page, perPage: 100 });
        if (listed.error) throw new HttpError(502, "AUTH_LOOKUP_FAILED", "The authentication provider could not be checked.");
        user = listed.data.users.find((candidate) => candidate.email?.toLowerCase() === email);
        if (listed.data.users.length < 100) break;
      }
      if (user) {
        const existingAdmin = (await db.query("select id from admin_users where profile_id=$1 and deleted_at is null", [user.id])).rows[0];
        if (existingAdmin) throw new HttpError(409, "ADMIN_ALREADY_EXISTS", "This email already belongs to an administrator.");
        const updated = await auth.service.auth.admin.updateUserById(user.id, { password: passwordResult.data, email_confirm: true, user_metadata: { ...user.user_metadata, full_name: fullName } });
        if (updated.error || !updated.data.user) throw new HttpError(409, "AUTH_ACCOUNT_EXISTS", "This email already belongs to an existing account. Use that account or choose another email.");
        user = updated.data.user;
      } else {
        const created = await auth.service.auth.admin.createUser({ email, password: passwordResult.data, email_confirm: true, user_metadata: { full_name: fullName } });
        if (created.error || !created.data.user) throw new HttpError(400, "ADMIN_CREATE_FAILED", created.error?.message || "The authentication account could not be created.");
        user = created.data.user;
        createdAuthUser = true;
      }
      try {
        const row = await db.transaction(async (client) => {
          await client.query("insert into profiles(id,full_name) values($1,$2) on conflict(id) do update set full_name=excluded.full_name,deleted_at=null,updated_at=now()", [user.id, fullName]);
          const inserted = (await client.query(
            `insert into admin_users(profile_id,role_id,status,two_factor_required,recovery_email,recovery_phone,recovery_phone_country,recovery_phone_hash,invited_by)
             values($1,$2,'active',true,$3,$4,$5,$6,$7) returning id,status,role_id`,
            [user.id, role.id, recoveryEmail, phone, recoveryCountryName || (recoveryCountryValue && recoveryCountryValue !== "OTHER" ? recoveryCountryValue : null), phone ? adminSecretHash(config.COOKIE_SECRET, phone) : null, req.admin.id],
          )).rows[0];
          await audit(client, req, "admin.create", "admin_user", inserted.id);
          return inserted;
        });
        ok(res, row, 201);
      } catch (error) {
        if (createdAuthUser) await auth.service.auth.admin.deleteUser(user.id);
        throw error;
      }
    }),
  );
  r.patch(
    "/admins/:id/role",
    auth.requireAdmin(["admins.manage"]),
    asyncRoute(async (req, res) => {
      uuid.parse(req.params.id);
      uuid.parse(req.body.roleId);
      const target = (
        await db.query("select is_super_admin from admin_users where id=$1", [
          req.params.id,
        ])
      ).rows[0];
      if (!target)
        throw new HttpError(404, "ADMIN_NOT_FOUND", "Administrator not found.");
      if (target.is_super_admin && !req.admin.is_super_admin)
        throw new HttpError(403, "SUPER_ADMIN_REQUIRED", "Only a Super Administrator may manage another Super Administrator.");
      const nextRole = (await db.query("select name from admin_roles where id=$1", [req.body.roleId])).rows[0];
      if (!nextRole) throw new HttpError(404, "ROLE_NOT_FOUND", "Administrator role not found.");
      if (nextRole.name === "Super Administrator")
        throw new HttpError(409, "SUPER_ROLE_PROTECTED", "The protected Super Administrator role cannot be assigned.");
      await ensureGrantable(req, req.body.roleId);
      if (target.is_super_admin && nextRole.name !== "Super Administrator") {
        const others = await db.query("select count(*) count from admin_users where id<>$1 and is_super_admin=true and status='active' and deleted_at is null", [req.params.id]);
        if (Number(others.rows[0]?.count || 0) === 0)
          throw new HttpError(409, "SUPER_ADMIN_PROTECTED", "The final active Super Administrator cannot be demoted.");
      }
      const row = (
        await db.query(
          "update admin_users set role_id=$2,is_super_admin=$3,updated_at=now() where id=$1 returning id,role_id,status,is_super_admin",
          [req.params.id, req.body.roleId, nextRole.name === "Super Administrator"],
        )
      ).rows[0];
      await audit(db, req, "admin.role_update", "admin_user", row.id);
      ok(res, row);
    }),
  );
  r.patch(
    "/admins/:id/status",
    auth.requireAdmin(["admins.manage"]),
    asyncRoute(async (req, res) => {
      uuid.parse(req.params.id);
      const status = String(req.body?.status || "");
      if (!['active','disabled'].includes(status))
        throw new HttpError(400, "STATUS_INVALID", "Administrator status is invalid.");
      if (req.params.id === req.admin.id && status === "disabled")
        throw new HttpError(409, "SELF_DISABLE_DENIED", "You cannot disable your own administrator account.");
      const target = (await db.query("select is_super_admin,status from admin_users where id=$1 and deleted_at is null", [req.params.id])).rows[0];
      if (!target) throw new HttpError(404, "ADMIN_NOT_FOUND", "Administrator not found.");
      if (target.is_super_admin && status === "disabled")
        throw new HttpError(409, "SUPER_ADMIN_PROTECTED", "A Super Administrator cannot be deactivated.");
      const row = (await db.query(
        "update admin_users set status=$2,deactivated_at=case when $2='disabled' then now() else null end,deactivated_by=case when $2='disabled' then $3 else null end,updated_at=now() where id=$1 returning id,status",
        [req.params.id, status, req.admin.id],
      )).rows[0];
      await audit(db, req, `admin.${status === 'active' ? 'activate' : 'deactivate'}`, "admin_user", row.id);
      ok(res, row);
    }),
  );
  r.patch(
    "/admins/:id/recovery",
    auth.requireAdmin(["admins.manage"]),
    asyncRoute(async (req, res) => {
      uuid.parse(req.params.id);
      const target = (await db.query("select is_super_admin from admin_users where id=$1 and deleted_at is null", [req.params.id])).rows[0];
      if (!target) throw new HttpError(404, "ADMIN_NOT_FOUND", "Administrator not found.");
      if (target.is_super_admin && !req.admin.is_super_admin)
        throw new HttpError(403, "SUPER_ADMIN_REQUIRED", "Only a Super Administrator may manage another Super Administrator.");
      const recoveryEmail = String(req.body?.recoveryEmail || "").trim().toLowerCase();
      if (recoveryEmail && !/^\S+@\S+\.\S+$/.test(recoveryEmail)) throw new HttpError(400, "RECOVERY_EMAIL_INVALID", "A valid recovery email is required.");
      const recoveryPhoneValue = String(req.body?.recoveryPhone || "").trim();
      const recoveryCountryValue = String(req.body?.recoveryPhoneCountry || "").trim().toUpperCase();
      const recoveryCountryName = String(req.body?.recoveryPhoneCountryName || "").trim();
      const phone = recoveryPhoneValue ? normalizeAdminPhone(recoveryPhoneValue, recoveryCountryValue) : null;
      if (recoveryPhoneValue) {
        parse(phoneCountry, recoveryCountryValue);
        if (recoveryCountryValue === "OTHER" && recoveryCountryName.length < 2)
          throw new HttpError(400, "PHONE_COUNTRY_REQUIRED", "Enter the recovery phone country.");
      }
      const row = (await db.query(
        "update admin_users set recovery_email=$2,recovery_phone=$3,recovery_phone_country=$4,recovery_phone_hash=$5,updated_at=now() where id=$1 and deleted_at is null returning id",
        [req.params.id, recoveryEmail || null, phone, recoveryCountryName || (recoveryCountryValue && recoveryCountryValue !== "OTHER" ? recoveryCountryValue : null), phone ? adminSecretHash(config.COOKIE_SECRET, phone) : null],
      )).rows[0];
      if (!row) throw new HttpError(404, "ADMIN_NOT_FOUND", "Administrator not found.");
      await audit(db, req, "admin.recovery_update", "admin_user", row.id);
      ok(res, { id: row.id, updated: true });
    }),
  );
  r.get(
    "/login-history",
    auth.requireAdmin(["admins.manage"]),
    asyncRoute(async (_req, res) => ok(res, (await db.query(
      `select l.id,l.succeeded,l.ip_address,l.user_agent,l.created_at,l.admin_user_id,p.full_name
       from admin_login_attempts l left join admin_users a on a.id=l.admin_user_id
       left join profiles p on p.id=a.profile_id order by l.created_at desc limit 250`,
    )).rows)),
  );
  r.get(
    "/permissions",
    auth.requireAdmin(["admins.manage"]),
    asyncRoute(async (_req, res) => ok(res, (await db.query("select id,code,description from admin_permissions order by code")).rows)),
  );
  r.patch(
    "/roles/:id/permissions",
    auth.requireAdmin(["admins.manage"]),
    asyncRoute(async (req, res) => {
      uuid.parse(req.params.id);
      const codes = Array.isArray(req.body?.permissions) ? [...new Set(req.body.permissions.map(String))] : [];
      const role = (await db.query("select name from admin_roles where id=$1", [req.params.id])).rows[0];
      if (!role) throw new HttpError(404, "ROLE_NOT_FOUND", "Administrator role not found.");
      if (role.name === "Super Administrator") throw new HttpError(409, "SUPER_ROLE_PROTECTED", "Super Administrator permissions are protected.");
      if (!req.admin.is_super_admin && codes.some((code) => !req.admin.permissions.includes(code)))
        throw new HttpError(403, "PERMISSION_ESCALATION_DENIED", "You cannot grant permissions you do not possess.");
      const available = await db.query("select id,code from admin_permissions where code=any($1::text[])", [codes]);
      if (available.rows.length !== codes.length) throw new HttpError(400, "PERMISSION_INVALID", "One or more permissions are invalid.");
      await db.transaction(async (client) => {
        await client.query("delete from admin_role_permissions where role_id=$1", [req.params.id]);
        if (available.rows.length) await client.query(
          "insert into admin_role_permissions(role_id,permission_id) select $1,unnest($2::uuid[])",
          [req.params.id, available.rows.map((row) => row.id)],
        );
        await audit(client, req, "role.permissions_update", "admin_role", req.params.id, { permissions: codes });
      });
      ok(res, { id: req.params.id, permissions: codes });
    }),
  );
  r.delete(
    "/admins/:id",
    auth.requireAdmin(["admins.manage"]),
    asyncRoute(async (req, res) => {
      uuid.parse(req.params.id);
      if (req.params.id === req.admin.id)
        throw new HttpError(409, "SELF_DELETE_DENIED", "You cannot remove your own administrator account.");
      const target = (await db.query("select is_super_admin from admin_users where id=$1 and deleted_at is null", [req.params.id])).rows[0];
      if (!target) throw new HttpError(404, "ADMIN_NOT_FOUND", "Administrator not found.");
      if (target.is_super_admin)
        throw new HttpError(409, "SUPER_ADMIN_PROTECTED", "A Super Administrator cannot be removed.");
      const row = (
        await db.query(
          "update admin_users set deleted_at=now(),status='disabled',deactivated_at=now(),deactivated_by=$2 where id=$1 returning id",
          [req.params.id, req.admin.id],
        )
      ).rows[0];
      await audit(db, req, "admin.delete", "admin_user", row.id);
      ok(res, { deleted: true });
    }),
  );
  r.get(
    "/audit-logs",
    auth.requireAdmin(["audit.read"]),
    asyncRoute(async (_req, res) =>
      ok(
        res,
        (
          await db.query(
            "select * from audit_logs order by created_at desc limit 500",
          )
        ).rows,
      ),
    ),
  );
  r.get(
    "/members",
    auth.requireAdmin(["memberships.read"]),
    asyncRoute(async (_req, res) =>
      ok(
        res,
        (
          await db.query(
            "select m.id,m.profile_id,m.status,m.starts_at,m.expires_at,p.full_name from memberships m left join profiles p on p.id=m.profile_id order by m.created_at desc",
          )
        ).rows,
      ),
    ),
  );
  r.get(
    "/admins",
    auth.requireAdmin(["admins.manage"]),
    asyncRoute(async (_req, res) =>
      ok(
        res,
        (
          await db.query(
            `select au.id,au.status,au.is_super_admin,au.two_factor_required,au.last_login_at,
              ar.id role_id,ar.name role,p.full_name,
              case when au.recovery_email is null then null else left(au.recovery_email,1)||'•••@'||split_part(au.recovery_email,'@',2) end recovery_email_masked,
              case when au.recovery_phone is null then null else repeat('•',greatest(length(au.recovery_phone)-4,0))||right(au.recovery_phone,4) end recovery_phone_masked
             from admin_users au join admin_roles ar on ar.id=au.role_id join profiles p on p.id=au.profile_id
             where au.deleted_at is null order by au.is_super_admin desc,p.full_name`,
          )
        ).rows,
      ),
    ),
  );
  r.get(
    "/notifications",
    asyncRoute(async (req, res) =>
      ok(
        res,
        (
          await db.query(
            "select id,kind,title,body,read_at,created_at from notifications where admin_user_id=$1 order by created_at desc limit 100",
            [req.admin.id],
          )
        ).rows,
      ),
    ),
  );
  r.post(
    "/notifications/:id/read",
    asyncRoute(async (req, res) => {
      const row = (
        await db.query(
          "update notifications set read_at=coalesce(read_at,now()) where id=$1 and admin_user_id=$2 returning id,read_at",
          [req.params.id, req.admin.id],
        )
      ).rows[0];
      if (!row)
        throw new HttpError(
          404,
          "NOTIFICATION_NOT_FOUND",
          "Notification not found.",
        );
      ok(res, row);
    }),
  );
  r.get(
    "/settings",
    auth.requireAdmin(["admins.manage"]),
    asyncRoute(async (_req, res) =>
      ok(
        res,
        Object.fromEntries(
          (
            await db.query("select key,value from app_settings order by key")
          ).rows.map((row) => [row.key, row.value]),
        ),
      ),
    ),
  );
  r.patch(
    "/settings",
    auth.requireAdmin(["admins.manage"]),
    asyncRoute(async (req, res) => {
      const allowed = new Set([
        "business_profile",
        "payment_methods",
        "order_hold_minutes",
        "notification_preferences",
      ]);
      const entries = Object.entries(req.body || {}).filter(([key]) =>
        allowed.has(key),
      );
      if (!entries.length)
        throw new HttpError(
          400,
          "SETTINGS_INVALID",
          "No supported settings were supplied.",
        );
      if (
        req.body.order_hold_minutes !== undefined &&
        (!Number.isInteger(req.body.order_hold_minutes) ||
          req.body.order_hold_minutes < 5 ||
          req.body.order_hold_minutes > 30)
      )
        throw new HttpError(
          400,
          "SETTINGS_INVALID",
          "Order hold minutes must be between 5 and 30.",
        );
      await db.transaction(async (client) => {
        for (const [key, value] of entries)
          await client.query(
            "insert into app_settings(key,value,updated_by) values($1,$2,$3) on conflict(key) do update set value=excluded.value,updated_by=excluded.updated_by,updated_at=now()",
            [key, value, req.admin.id],
          );
        await audit(client, req, "settings.update", "settings", null, {
          keys: entries.map(([key]) => key),
        });
      });
      ok(res, { updated: entries.map(([key]) => key) });
    }),
  );
  r.get(
    "/payment-destinations",
    auth.requireAdmin(["payments.read"]),
    asyncRoute(async (_req, res) =>
      ok(
        res,
        (
          await db.query(
            "select id,provider,display_label,public_instructions,currency,verification_status,enabled,verified_at,created_at,updated_at from payment_destinations where deleted_at is null order by provider,display_label",
          )
        ).rows,
      ),
    ),
  );
  r.post(
    "/payment-destinations",
    auth.requireAdmin(["payments.destinations.manage"]),
    asyncRoute(async (req, res) => {
      const provider = String(req.body?.provider || "");
      const displayLabel = String(req.body?.displayLabel || "").trim();
      const instructions = String(req.body?.publicInstructions || "").trim();
      const currency = String(req.body?.currency || "").toUpperCase();
      if (
        !["cash_app", "chime"].includes(provider) ||
        displayLabel.length < 2 ||
        instructions.length < 2 ||
        !/^[A-Z]{3}$/.test(currency) ||
        /(account|routing)[\s_-]*number/i.test(instructions)
      )
        throw new HttpError(
          400,
          "DESTINATION_INVALID",
          "Provide a supported provider, safe masked instructions, label and currency.",
        );
      const row = (
        await db.query(
          "insert into payment_destinations(provider,display_label,public_instructions,currency,verification_status,enabled,created_by,updated_by) values($1,$2,$3,$4,'draft',false,$5,$5) returning *",
          [provider, displayLabel, instructions, currency, req.admin.id],
        )
      ).rows[0];
      await audit(
        db,
        req,
        "payment_destination.create",
        "payment_destination",
        row.id,
      );
      ok(res, row, 201);
    }),
  );
  r.patch(
    "/payment-destinations/:id",
    auth.requireAdmin(["payments.destinations.manage"]),
    asyncRoute(async (req, res) => {
      uuid.parse(req.params.id);
      const label = String(req.body?.displayLabel || "").trim();
      const instructions = String(req.body?.publicInstructions || "").trim();
      const currency = String(req.body?.currency || "").toUpperCase();
      if (
        label.length < 2 ||
        instructions.length < 2 ||
        !/^[A-Z]{3}$/.test(currency) ||
        /(account|routing)[\s_-]*number/i.test(instructions)
      )
        throw new HttpError(
          400,
          "DESTINATION_INVALID",
          "Destination details are invalid.",
        );
      const row = (
        await db.query(
          "update payment_destinations set display_label=$2,public_instructions=$3,currency=$4,verification_status='unverified',enabled=false,verified_by=null,verified_at=null,updated_by=$5 where id=$1 and deleted_at is null returning *",
          [req.params.id, label, instructions, currency, req.admin.id],
        )
      ).rows[0];
      if (!row)
        throw new HttpError(
          404,
          "DESTINATION_NOT_FOUND",
          "Payment destination not found.",
        );
      await audit(
        db,
        req,
        "payment_destination.update",
        "payment_destination",
        row.id,
      );
      ok(res, row);
    }),
  );
  r.post(
    "/payment-destinations/:id/verify",
    auth.requireAdmin(["payments.destinations.manage"]),
    asyncRoute(async (req, res) => {
      uuid.parse(req.params.id);
      if (!req.admin.is_super_admin)
        throw new HttpError(
          403,
          "SUPER_ADMIN_REQUIRED",
          "Only the Super Administrator can verify a payment destination.",
        );
      const enabled = req.body?.enabled !== false;
      const row = (
        await db.query(
          "update payment_destinations set verification_status='verified',enabled=$2,verified_by=$3,verified_at=now(),updated_by=$3 where id=$1 and deleted_at is null returning *",
          [req.params.id, enabled, req.admin.id],
        )
      ).rows[0];
      if (!row)
        throw new HttpError(
          404,
          "DESTINATION_NOT_FOUND",
          "Payment destination not found.",
        );
      await audit(
        db,
        req,
        "payment_destination.verify",
        "payment_destination",
        row.id,
      );
      ok(res, row);
    }),
  );
  r.post(
    "/payments/:id/assign-details",
    auth.requireAdmin(["payments.assign"]),
    asyncRoute(async (req, res) => {
      uuid.parse(req.params.id);
      const paymentMethod = String(req.body?.paymentMethod || "");
      const accountName = String(req.body?.accountName || "").trim();
      const bankName = String(req.body?.bankName || "").trim();
      const accountNumber = String(req.body?.accountNumber || "").trim();
      const paymentIdentifier = String(
        req.body?.paymentIdentifier || "",
      ).trim();
      const instructions = String(req.body?.instructions || "").trim();
      const amountMinor = Number(req.body?.amountMinor);
      const currency = String(req.body?.currency || "").toUpperCase();
      const expiresAt = new Date(String(req.body?.expiresAt || ""));
      if (
        !["paypal", "cash_app", "chime", "bank_transfer", "gift_card"].includes(
          paymentMethod,
        ) ||
        (paymentMethod === "bank_transfer" &&
          (accountName.length < 2 ||
            accountName.length > 160 ||
            bankName.length < 2 ||
            bankName.length > 160 ||
            accountNumber.length < 4 ||
            accountNumber.length > 100)) ||
        (paymentMethod !== "bank_transfer" &&
          paymentMethod !== "gift_card" &&
          (paymentIdentifier.length < 2 || paymentIdentifier.length > 500)) ||
        !Number.isInteger(amountMinor) ||
        !/^[A-Z]{3}$/.test(currency) ||
        instructions.length > 2000 ||
        Number.isNaN(expiresAt.valueOf()) ||
        expiresAt.valueOf() < Date.now() + 15 * 60 * 1000 ||
        expiresAt.valueOf() > Date.now() + 7 * 24 * 60 * 60 * 1000
      )
        throw new HttpError(
          400,
          "PAYMENT_DETAILS_INVALID",
          "Enter complete payment details with an expiry between 15 minutes and 7 days.",
        );
      const row = await db.transaction(async (c) => {
        const payment = (
          await c.query(
            "select p.*,o.reference order_reference from payments p join orders o on o.id=p.order_id where p.id=$1 for update",
            [req.params.id],
          )
        ).rows[0];
        if (
          !payment ||
          payment.provider !== "manual" ||
          !["awaiting_payment_details", "payment_details_expired"].includes(
            payment.status,
          )
        )
          throw new HttpError(
            409,
            "ASSIGNMENT_NOT_ALLOWED",
            "Payment is not awaiting manual instructions.",
          );
        if (
          paymentMethod !== payment.method ||
          amountMinor !== Number(payment.amount_minor) ||
          currency !== payment.currency
        )
          throw new HttpError(
            409,
            "PAYMENT_DETAILS_MISMATCH",
            "Payment method, amount and currency must match the order.",
          );
        const paymentReference = `PAY-${payment.order_reference}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
        await c.query(
          "update payment_assignments set status='expired',updated_at=now() where order_id=$1 and status='active'",
          [payment.order_id],
        );
        const assignment = (
          await c.query(
            "insert into payment_assignments(order_id,payment_id,assigned_by,payment_method,bank_name,account_name,account_number,payment_identifier,payment_reference,amount_minor,currency,instructions,expires_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning id,order_id,payment_id,payment_method,bank_name,account_name,account_number,payment_identifier,payment_reference,amount_minor,currency,status,expires_at,created_at",
            [
              payment.order_id,
              payment.id,
              req.admin.id,
              paymentMethod,
              paymentMethod === "bank_transfer" ? bankName : null,
              paymentMethod === "bank_transfer" ? accountName : null,
              paymentMethod === "bank_transfer" ? accountNumber : null,
              paymentMethod === "bank_transfer" ? null : paymentIdentifier,
              paymentReference,
              payment.amount_minor,
              payment.currency,
              instructions || null,
              expiresAt.toISOString(),
            ],
          )
        ).rows[0];
        await c.query(
          "update payments set status='payment_details_ready',updated_at=now() where id=$1",
          [payment.id],
        );
        await c.query(
          "update orders set status='payment_details_ready',payment_status='payment_details_ready',updated_at=now() where id=$1",
          [payment.order_id],
        );
        await c.query(
          "insert into notifications(profile_id,kind,title,body) select profile_id,'payment_details_ready','Payment details ready','Your administrator-assigned off-site payment details are ready.' from orders where id=$1 and profile_id is not null",
          [payment.order_id],
        );
        await audit(
          c,
          req,
          "payment_details.assign",
          "payment_assignment",
          assignment.id,
          {
            paymentMethod,
            amountMinor,
            currency,
            expiresAt: expiresAt.toISOString(),
          },
        );
        return assignment;
      });
      ok(res, row, 201);
    }),
  );
  r.get(
    "/payments/:id/evidence",
    auth.requireAdmin(["payments.read"]),
    asyncRoute(async (req, res) => {
      const row = (
        await db.query(
          "select id,evidence_storage_path,evidence_scan_status,gift_card_code from manual_payment_submissions where payment_id=$1 order by created_at desc limit 1",
          [req.params.id],
        )
      ).rows[0];
      if (!row)
        throw new HttpError(
          404,
          "EVIDENCE_NOT_FOUND",
          "No evidence is attached.",
        );
      if (row.evidence_storage_path && row.evidence_scan_status !== "clean")
        throw new HttpError(
          423,
          "EVIDENCE_QUARANTINED",
          "Evidence cannot be opened until an approved malware scanner marks it clean.",
        );
      await audit(
        db,
        req,
        row.evidence_storage_path ? "payment_evidence.view" : "payment_gift_card_code.view",
        "manual_payment_submission",
        row.id,
      );
      let signedUrl = null;
      if (row.evidence_storage_path) {
        await db.query(
          "insert into payment_evidence_access_logs(submission_id,admin_user_id,request_id) values($1,$2,$3)",
          [row.id, req.admin.id, res.locals.requestId],
        );
        const { data, error } = await auth.service.storage
          .from(
            process.env.MANUAL_PAYMENT_EVIDENCE_BUCKET ||
              "manual-payment-evidence",
          )
          .createSignedUrl(row.evidence_storage_path, 60);
        if (error)
          throw new HttpError(
            502,
            "EVIDENCE_UNAVAILABLE",
            "Evidence could not be opened securely.",
          );
        signedUrl = data.signedUrl;
      }
      ok(res, {
        signedUrl,
        giftCardCode: row.gift_card_code,
        expiresIn: signedUrl ? 60 : null,
        notice:
          "Gift card code and image evidence are supporting material only and do not prove receipt.",
      });
    }),
  );
  return r;
}

function adminSecretHash(secret, value) {
  return crypto.createHmac("sha256", secret).update(value).digest("hex");
}
