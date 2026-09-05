import { Router } from "express";
import crypto from "node:crypto";
import { processEvidenceSubmission } from "../scanning/evidence.js";
import { asyncRoute, HttpError, ok } from "../http.js";
import {
  membershipInput,
  newsletterInput,
  orderInput,
  parse,
  serviceInput,
  supportInput,
} from "../schemas.js";

export function publicRoutes({ db, auth, publicLimiter, config }) {
  const router = Router();
  const optionalUserId = async (req) =>
    req.cookies.customer_access_token
      ? (await auth.service.auth.getUser(req.cookies.customer_access_token)).data.user
          ?.id || null
      : null;
  router.get("/config", (_req, res) =>
    ok(res, {
      payments: {
        paypal: true,
        cash_app: true,
        chime: true,
        bank_transfer: true,
        gift_card: true,
      },
      maxOrderQuantity: 10,
      developmentDemo: { enabled: false },
    }),
  );
  router.get(
    "/events",
    asyncRoute(async (req, res) => {
      const q = `%${String(req.query.q || "").slice(0, 100)}%`;
      const city = String(req.query.city || "").slice(0, 100);
      const from = req.query.from ? new Date(String(req.query.from)) : null;
      const to = req.query.to ? new Date(String(req.query.to)) : null;
      if (
        (from && Number.isNaN(from.valueOf())) ||
        (to && Number.isNaN(to.valueOf()))
      )
        throw new HttpError(
          400,
          "DATE_FILTER_INVALID",
          "Event date filter is invalid.",
        );
      const rows = (
        await db.query(
          `select e.id,e.slug,e.title,e.description,e.venue,e.city,e.country,e.starts_at,e.currency,min(es.price_minor) starting_price_minor from events e join event_sections es on es.event_id=e.id and es.deleted_at is null where e.status='published' and e.deleted_at is null and ($1='%%' or e.title ilike $1 or e.city ilike $1 or e.venue ilike $1) and ($2='' or lower(e.city)=lower($2)) and ($3::timestamptz is null or e.starts_at >= $3) and ($4::timestamptz is null or e.starts_at < $4) group by e.id order by e.starts_at`,
          [q, city, from?.toISOString() || null, to?.toISOString() || null],
        )
      ).rows;
      ok(res, rows);
    }),
  );
  router.get(
    "/events/:slug",
    asyncRoute(async (req, res) => {
      const event = (
        await db.query(
          "select id,slug,title,description,venue,city,country,starts_at,currency from events where slug=$1 and status='published' and deleted_at is null",
          [req.params.slug],
        )
      ).rows[0];
      if (!event)
        throw new HttpError(404, "EVENT_NOT_FOUND", "Event not found.");
      event.sections = (
        await db.query(
          `select es.id,es.name,es.description,es.price_minor,greatest(ti.available_quantity-ti.held_quantity-ti.sold_quantity,0) available_quantity from event_sections es join ticket_inventory ti on ti.section_id=es.id where es.event_id=$1 and es.deleted_at is null order by es.price_minor`,
          [event.id],
        )
      ).rows;
      ok(res, event);
    }),
  );
  router.post(
    "/orders",
    publicLimiter,
    asyncRoute(async (req, res) => {
      const input = parse(orderInput, req.body);
      const key = req.get("idempotency-key");
      if (!key || key.length > 100)
        throw new HttpError(
          400,
          "IDEMPOTENCY_KEY_REQUIRED",
          "A valid Idempotency-Key header is required.",
        );
      const userId = await optionalUserId(req);
      if (!userId)
        throw new HttpError(
          401,
          "AUTHENTICATION_REQUIRED",
          "Sign in before submitting an order so only you can view its payment details.",
        );
      const order = await db.transaction(async (client) => {
        const existing = (
          await client.query(
            "select id,reference,status,payment_status,total_minor,currency,hold_expires_at,true as reused from orders where checkout_idempotency_key=$1",
            [key],
          )
        ).rows[0];
        if (existing) return existing;
        const section = (
          await client.query(
            `select es.id,es.event_id,es.price_minor,e.currency,e.status,ti.available_quantity,ti.held_quantity,ti.sold_quantity from event_sections es join events e on e.id=es.event_id join ticket_inventory ti on ti.section_id=es.id where es.id=$1 and es.event_id=$2 and es.deleted_at is null and e.deleted_at is null for update of ti`,
            [input.sectionId, input.eventId],
          )
        ).rows[0];
        if (!section || section.status !== "published")
          throw new HttpError(
            404,
            "TICKET_OPTION_UNAVAILABLE",
            "Ticket option is unavailable.",
          );
        if (
          section.available_quantity -
            section.held_quantity -
            Number(section.sold_quantity || 0) <
          input.quantity
        )
          throw new HttpError(
            409,
            "INSUFFICIENT_INVENTORY",
            "The requested quantity is no longer available.",
          );
        const total = section.price_minor * input.quantity;
        const reference = `ORD-${crypto.randomBytes(5).toString("hex").toUpperCase()}`;
        const inserted = (
          await client.query(
            `insert into orders(profile_id,event_id,reference,status,payment_status,currency,subtotal_minor,total_minor,contact_name,contact_email,contact_phone,contact_country,checkout_idempotency_key,hold_expires_at) values($1,$2,$3,'pending_payment','pending',$4,$5,$5,$6,$7,$8,$9,$10,now()+interval '15 minutes') returning id,reference,status,payment_status,total_minor,currency,hold_expires_at`,
            [
              userId,
              input.eventId,
              reference,
              section.currency,
              total,
              input.contactName,
              input.contactEmail,
              input.contactPhone,
              input.contactCountry,
              key,
            ],
          )
        ).rows[0];
        await client.query(
          "insert into order_items(order_id,event_section_id,description,quantity,unit_price_minor,total_minor) values($1,$2,'Ticket order request',$3,$4,$5)",
          [
            inserted.id,
            input.sectionId,
            input.quantity,
            section.price_minor,
            total,
          ],
        );
        await client.query(
          "update ticket_inventory set held_quantity=held_quantity+$2,updated_at=now() where section_id=$1",
          [input.sectionId, input.quantity],
        );
        await client.query(
          "update orders set status='awaiting_payment_details',payment_status='awaiting_payment_details',updated_at=now() where id=$1",
          [inserted.id],
        );
        inserted.status = "awaiting_payment_details";
        inserted.payment_status = "awaiting_payment_details";
        await client.query(
          "insert into payments(order_id,provider,method,status,amount_minor,currency,idempotency_key) values($1,$2,$3,$4,$5,$6,$7)",
          [
            inserted.id,
            "manual",
            input.paymentMethod,
            "awaiting_payment_details",
            total,
            section.currency,
            key,
          ],
        );
        await client.query(
          `insert into notifications(admin_user_id,kind,title,body)
           select au.id,'payment_details_required','Payment details required','An order is awaiting transaction-specific off-site payment instructions.'
           from admin_users au where status='active' and deleted_at is null and
           (au.is_super_admin or exists(select 1 from admin_role_permissions arp join admin_permissions ap on ap.id=arp.permission_id where arp.role_id=au.role_id and ap.code='payments.assign'))`,
        );
        await client.query(
          "insert into audit_logs(action,entity_type,entity_id,request_id,metadata) values('payment.details_requested','order',$1,$2,$3)",
          [
            inserted.id,
            res.locals.requestId,
            { profileId: userId, paymentMethod: input.paymentMethod },
          ],
        );
        return inserted;
      });
      ok(
        res,
        {
          reference: order.reference,
          status: order.status,
          payment_status: order.payment_status,
          total_minor: order.total_minor,
          currency: order.currency,
          hold_expires_at: order.hold_expires_at,
          message:
            "Preparing your payment details. An administrator has been notified and your payment instructions will appear here shortly.",
        },
        201,
      );
    }),
  );
  router.post(
    "/newsletter/subscribe",
    publicLimiter,
    asyncRoute(async (req, res) => {
      const i = parse(newsletterInput, req.body);
      const existing = (
        await db.query(
          "select id,email,status from newsletter_subscribers where lower(email)=lower($1) limit 1",
          [i.email],
        )
      ).rows[0];
      if (existing) {
        ok(
          res,
          {
            id: existing.id,
            email: existing.email,
            status: "already_subscribed",
            message: "This email is already subscribed.",
          },
          200,
        );
        return;
      }
      const row = (
        await db.query(
          "insert into newsletter_subscribers(email,status) values($1,'active') returning id,email,status",
          [i.email],
        )
      ).rows[0];
      ok(
        res,
        {
          id: row.id,
          email: row.email,
          status: row.status,
          message: "You are subscribed to updates.",
        },
        201,
      );
    }),
  );
  router.post(
    "/membership-applications",
    publicLimiter,
    auth.requireUser,
    asyncRoute(async (req, res) => {
      const i = parse(membershipInput, req.body);
      if (i.email.toLowerCase() !== req.user.email.toLowerCase())
        throw new HttpError(
          400,
          "APPLICATION_EMAIL_MISMATCH",
          "Use the email address connected to your signed-in account.",
        );
      const profileId = req.user.id;
      const row = (
        await db.query(
          `insert into membership_applications(profile_id,full_name,email,country,reason,interest,status) values($1,$2,$3,$4,$5,$6,'pending') on conflict (lower(email)) where status in ('pending','on_hold') do nothing returning id,status,created_at`,
          [profileId, i.fullName, i.email, i.country, i.reason, i.interest],
        )
      ).rows[0];
      if (!row)
        throw new HttpError(
          409,
          "APPLICATION_EXISTS",
          "An active application already exists for this email.",
        );
      ok(res, row, 201);
    }),
  );
  router.post(
    "/service-requests",
    publicLimiter,
    asyncRoute(async (req, res) => {
      const i = parse(serviceInput, req.body);
      const profileId = await optionalUserId(req);
      const row = (
        await db.query(
          "insert into service_requests(profile_id,category,full_name,email,phone,message,status) values($1,$2,$3,$4,$5,$6,'new') returning id,status,created_at",
          [profileId, i.category, i.fullName, i.email, i.phone, i.message],
        )
      ).rows[0];
      ok(res, row, 201);
    }),
  );
  router.post(
    "/support-requests",
    publicLimiter,
    asyncRoute(async (req, res) => {
      const i = parse(supportInput, req.body);
      if (i.website)
        throw new HttpError(400, "SPAM_REJECTED", "Request rejected.");
      const profileId = await optionalUserId(req);
      const row = (
        await db.query(
          "insert into customer_support_requests(profile_id,name,email,order_reference,message,status,ip_hash) values($1,$2,$3,$4,$5,'new',$6) returning id,created_at",
          [
            profileId,
            i.name,
            i.email,
            i.orderReference,
            i.message,
            crypto
              .createHash("sha256")
              .update(req.ip || "")
              .digest("hex"),
          ],
        )
      ).rows[0];
      ok(res, row, 201);
    }),
  );
  router.get(
    "/account/notifications",
    auth.requireUser,
    asyncRoute(async (req, res) =>
      ok(
        res,
        (
          await db.query(
            "select id,kind,title,body,read_at,created_at from notifications where profile_id=$1 order by created_at desc limit 50",
            [req.user.id],
          )
        ).rows,
      ),
    ),
  );
  router.get(
    "/account/orders",
    auth.requireUser,
    asyncRoute(async (req, res) =>
      ok(
        res,
        (
          await db.query(
            "select o.reference,o.status,o.payment_status,o.total_minor,o.currency,o.created_at,e.title event_title,e.venue event_venue,e.city event_city,e.starts_at event_starts_at,p.id payment_id,p.method,p.status current_payment_status from orders o join events e on e.id=o.event_id left join lateral(select id,method,status from payments where order_id=o.id order by created_at desc limit 1)p on true where o.profile_id=$1 order by o.created_at desc",
            [req.user.id],
          )
        ).rows,
      ),
    ),
  );
  router.get(
    "/account/payments/:id/instructions",
    auth.requireUser,
    asyncRoute(async (req, res) => {
      await db.query("select public.expire_payment_assignments()");
      const row = (
        await db.query(
          `select pa.id assignment_id,pa.payment_method,pa.bank_name,pa.account_name,pa.account_number,pa.payment_identifier,
                  pa.instructions,pa.payment_reference,pa.amount_minor,pa.currency,pa.status,pa.expires_at
           from payment_assignments pa join orders o on o.id=pa.order_id
           where pa.payment_id=$1 and o.profile_id=$2 and pa.status in ('active','submitted')`,
          [req.params.id, req.user.id],
        )
      ).rows[0];
      if (!row)
        throw new HttpError(
          404,
          "PAYMENT_DETAILS_UNAVAILABLE",
          "Payment instructions are not active.",
        );
      ok(res, row);
    }),
  );
  router.post(
    "/account/payments/:id/request-fresh-instructions",
    auth.requireUser,
    asyncRoute(async (req, res) => {
      const row = (
        await db.query(
          `update payments p set status='awaiting_payment_details',updated_at=now()
           from orders o where p.id=$1 and o.id=p.order_id and o.profile_id=$2
           and p.provider='manual' and p.status='payment_details_expired' returning p.order_id`,
          [req.params.id, req.user.id],
        )
      ).rows[0];
      if (!row)
        throw new HttpError(
          409,
          "REFRESH_NOT_ALLOWED",
          "Fresh instructions can be requested only after expiry.",
        );
      await db.query(
        "update orders set status='awaiting_payment_details',payment_status='awaiting_payment_details',updated_at=now() where id=$1",
        [row.order_id],
      );
      await db.query(
        `insert into notifications(admin_user_id,kind,title,body) select au.id,'payment_details_required','Fresh payment details requested','A customer requested replacement manual-payment instructions.' from admin_users au where status='active' and deleted_at is null and (au.is_super_admin or exists(select 1 from admin_role_permissions arp join admin_permissions ap on ap.id=arp.permission_id where arp.role_id=au.role_id and ap.code='payments.assign'))`,
      );
      await db.query(
        "insert into audit_logs(action,entity_type,entity_id,request_id,metadata) values('payment.fresh_details_requested','order',$1,$2,$3)",
        [row.order_id, res.locals.requestId, { profileId: req.user.id }],
      );
      ok(res, {
        status: "awaiting_payment_details",
        message:
          "Preparing your payment details. An administrator has been notified and your payment instructions will appear here shortly.",
      });
    }),
  );
  router.post(
    "/account/payments/:id/manual-submission",
    auth.requireUser,
    asyncRoute(async (req, res) => {
      const note = String(req.body?.note || "").slice(0, 2000);
      const giftCardCode = String(req.body?.giftCardCode || "").trim();
      const evidencePath = req.body?.evidenceStoragePath
        ? String(req.body.evidenceStoragePath).slice(0, 500)
        : null;
      const row = await db.transaction(async (c) => {
        const payment = (
          await c.query(
             `select p.id,p.order_id,p.provider,p.method,p.status,pa.id assignment_id
             from payments p join orders o on o.id=p.order_id
             join payment_assignments pa on pa.payment_id=p.id and pa.status='active' and pa.expires_at>now()
             where p.id=$1 and o.profile_id=$2 for update of p`,
            [req.params.id, req.user.id],
          )
        ).rows[0];
        if (!payment)
          throw new HttpError(
            404,
            "PAYMENT_NOT_FOUND",
            "Manual payment was not found.",
          );
        if (
          payment.provider !== "manual" ||
          !["paypal", "cash_app", "chime", "bank_transfer", "gift_card"].includes(
            payment.method,
          )
        )
          throw new HttpError(
            400,
            "NOT_MANUAL_PAYMENT",
            "This payment does not use manual review.",
          );
        if (giftCardCode && payment.method !== "gift_card")
          throw new HttpError(
            400,
            "GIFT_CARD_CODE_NOT_ALLOWED",
            "A gift card code can only be submitted for a gift card payment.",
          );
        if (giftCardCode && (giftCardCode.length < 4 || giftCardCode.length > 200))
          throw new HttpError(
            400,
            "GIFT_CARD_CODE_INVALID",
            "The gift card code must be between 4 and 200 characters.",
          );
        if (payment.method === "gift_card" && !evidencePath && !giftCardCode)
          throw new HttpError(
            400,
            "GIFT_CARD_PROOF_REQUIRED",
            "Enter the gift card code or upload an image of the gift card.",
          );
        if (payment.method !== "gift_card" && !evidencePath)
          throw new HttpError(
            400,
            "EVIDENCE_REQUIRED",
            "Upload payment proof before submitting for verification.",
          );
        if (
          evidencePath &&
          !evidencePath.startsWith(`${req.user.id}/${payment.id}/`)
        )
          throw new HttpError(
            400,
            "EVIDENCE_PATH_INVALID",
            "Evidence path is not valid for this payment.",
          );
        const submission = (
          await c.query(
            "insert into manual_payment_submissions(payment_id,evidence_storage_path,gift_card_code,customer_note,status,evidence_scan_status) values($1,$2,$3,$4,'submitted',$5) returning id,status,created_at",
            [payment.id, evidencePath, giftCardCode || null, note, evidencePath ? "pending" : "clean"],
          )
        ).rows[0];
        const scanResult = evidencePath
          ? await processEvidenceSubmission({
              db: c,
              storage: auth.service.storage,
              bucketName: config.MANUAL_PAYMENT_EVIDENCE_BUCKET,
              submissionId: submission.id,
              apiKey: config.VIRUSTOTAL_API_KEY,
            })
          : { status: "clean", mode: "not_applicable", reason: "No image evidence attached." };
        await c.query(
          "update payments set status='pending_verification',updated_at=now() where id=$1",
          [payment.id],
        );
        await c.query(
          "update orders set payment_status='pending_verification',status='pending_verification',updated_at=now() where id=$1",
          [payment.order_id],
        );
        await c.query(
          "update payment_assignments set status='submitted',updated_at=now() where id=$1",
          [payment.assignment_id],
        );
        await c.query(
          `insert into notifications(admin_user_id,kind,title,body) select au.id,'manual_verification','Manual payment submitted','A customer payment reference requires business-account verification.' from admin_users au where status='active' and deleted_at is null and (au.is_super_admin or exists(select 1 from admin_role_permissions arp join admin_permissions ap on ap.id=arp.permission_id where arp.role_id=au.role_id and ap.code='payments.verify'))`,
        );
        await c.query(
          "insert into audit_logs(action,entity_type,entity_id,request_id,metadata) values('payment.customer_submitted','payment',$1,$2,$3)",
          [
            payment.id,
            res.locals.requestId,
            {
              profileId: req.user.id,
              assignmentId: payment.assignment_id,
            },
          ],
        );
        return { ...submission, scanStatus: scanResult.status, scanMode: scanResult.mode, scanReason: scanResult.reason };
      });
      ok(
        res,
        {
          ...row,
          scanStatus: row.scanStatus,
          scanMode: row.scanMode,
          scanReason: row.scanReason,
          message:
            row.scanStatus === "clean"
              ? "Payment submitted and evidence passed safety review. Verification is in progress."
              : "Payment submitted. Verification is in progress. Evidence is quarantined for safety review and does not confirm that payment was received.",
        },
        201,
      );
    }),
  );
  router.post(
    "/account/payments/:id/evidence-upload",
    auth.requireUser,
    asyncRoute(async (req, res) => {
      const payment = (
        await db.query(
          "select p.id from payments p join orders o on o.id=p.order_id where p.id=$1 and o.profile_id=$2 and p.provider='manual'",
          [req.params.id, req.user.id],
        )
      ).rows[0];
      if (!payment)
        throw new HttpError(
          404,
          "PAYMENT_NOT_FOUND",
          "Manual payment was not found.",
        );
      const filename = String(req.body?.filename || "");
      const contentType = String(req.body?.contentType || "");
      const size = Number(req.body?.size);
      if (
        !/^[a-zA-Z0-9._-]{1,120}$/.test(filename) ||
        !/^(image\/(png|jpeg|webp)|application\/pdf)$/.test(contentType) ||
        !Number.isInteger(size) ||
        size < 1 ||
        size > 5 * 1024 * 1024
      )
        throw new HttpError(
          400,
          "EVIDENCE_INVALID",
          "Evidence must be a PNG, JPEG, WebP or PDF no larger than 5 MB.",
        );
      const storagePath = `${req.user.id}/${payment.id}/${crypto.randomUUID()}-${filename}`;
      const { data, error } = await auth.service.storage
        .from(config.MANUAL_PAYMENT_EVIDENCE_BUCKET)
        .createSignedUploadUrl(storagePath);
      if (error)
        throw new HttpError(
          502,
          "EVIDENCE_UPLOAD_UNAVAILABLE",
          "Secure evidence upload is unavailable.",
        );
      ok(res, {
        path: storagePath,
        token: data.token,
        signedUrl: data.signedUrl,
        maxBytes: 5 * 1024 * 1024,
        acceptedTypes: [
          "image/png",
          "image/jpeg",
          "image/webp",
          "application/pdf",
        ],
      });
    }),
  );
  router.get(
    "/account/membership-applications",
    auth.requireUser,
    asyncRoute(async (req, res) =>
      ok(
        res,
        (
          await db.query(
            `select a.id,a.status,a.created_at,a.reviewed_at,
              m.status membership_status,m.starts_at membership_starts_at,m.expires_at membership_expires_at
             from membership_applications a
             left join memberships m on m.application_id=a.id
             where a.profile_id=$1 order by a.created_at desc`,
            [req.user.id],
          )
        ).rows,
      ),
    ),
  );
  router.get(
    "/account/service-requests",
    auth.requireUser,
    asyncRoute(async (req, res) =>
      ok(
        res,
        (
          await db.query(
            "select id,category,status,created_at,updated_at from service_requests where profile_id=$1 order by created_at desc",
            [req.user.id],
          )
        ).rows,
      ),
    ),
  );
  return router;
}
