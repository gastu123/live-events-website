import { Router } from "express";
import { asyncRoute, HttpError, ok } from "../http.js";

async function applyVerifiedPayment(
  db,
  res,
  { provider, eventId, eventType, payload, verified },
) {
  const inserted = (
    await db.query(
      "insert into payment_webhook_events(provider,event_id,event_type,payload,signature_verified,processing_status) values($1,$2,$3,$4,true,'received') on conflict(provider,event_id) do nothing returning id",
      [provider, eventId, eventType, payload],
    )
  ).rows[0];
  if (!inserted) return { duplicate: true };
  if (!verified.successful) {
    await db.query(
      "update payment_webhook_events set processing_status='ignored',processed_at=now() where id=$1",
      [inserted.id],
    );
    return { processed: true, ignored: true };
  }
  try {
    return await db.transaction(async (client) => {
      const payment = (
        await client.query(
          "select p.*,o.reference from payments p join orders o on o.id=p.order_id where p.provider=$1 and (p.provider_reference=$2 or o.reference=$3) for update",
          [
            provider,
            verified.lookupReference || verified.providerReference,
            verified.orderReference,
          ],
        )
      ).rows[0];
      if (!payment)
        throw new HttpError(
          404,
          "PAYMENT_NOT_FOUND",
          "Payment record not found.",
        );
      if (Number(verified.amountMinor) !== Number(payment.amount_minor))
        throw new HttpError(
          409,
          "PAYMENT_AMOUNT_MISMATCH",
          "Verified payment amount does not match the order.",
        );
      if (verified.currency !== payment.currency)
        throw new HttpError(
          409,
          "PAYMENT_CURRENCY_MISMATCH",
          "Verified payment currency does not match the order.",
        );
      if (
        verified.orderReference &&
        verified.orderReference !== payment.reference
      )
        throw new HttpError(
          409,
          "PAYMENT_ORDER_MISMATCH",
          "Verified payment reference does not match the order.",
        );
      if (["provider_verified", "successful"].includes(payment.status)) {
        await client.query(
          "update payment_webhook_events set processing_status='processed',processed_at=now() where id=$1",
          [inserted.id],
        );
        return { duplicate: true };
      }
      await client.query(
        "update payments set status='provider_verified',provider_reference=$2,verified_at=now(),verification_source=$3,updated_at=now() where id=$1",
        [
          payment.id,
          verified.providerReference,
          `${provider}_signed_webhook_and_api`,
        ],
      );
      await client.query(
        "update orders set payment_status='provider_verified',status='provider_verified',updated_at=now() where id=$1",
        [payment.order_id],
      );
      await client.query(
        `insert into notifications(admin_user_id,kind,title,body)
         select au.id,'provider_verified','Provider payment awaiting final review','A provider-verified payment requires final approval.'
         from admin_users au where au.status='active' and au.deleted_at is null and
         (au.is_super_admin or exists(select 1 from admin_role_permissions arp join admin_permissions ap on ap.id=arp.permission_id where arp.role_id=au.role_id and ap.code='payments.final_approve'))`,
      );
      await client.query(
        "insert into audit_logs(action,entity_type,entity_id,request_id,metadata) values($1,'payment',$2,$3,$4)",
        [
          `payment.${provider}_verified`,
          payment.id,
          res.locals.requestId,
          { eventId },
        ],
      );
      await client.query(
        "update payment_webhook_events set processing_status='processed',processed_at=now() where id=$1",
        [inserted.id],
      );
      return {
        processed: true,
        paymentStatus: "provider_verified",
        orderStatus: "provider_verified",
      };
    });
  } catch (error) {
    if (Number(error.status) >= 500 || !error.status) {
      await db.query("delete from payment_webhook_events where id=$1", [
        inserted.id,
      ]);
    } else {
      await db.query(
        "update payment_webhook_events set processing_status='rejected',processing_error=$2,processed_at=now() where id=$1",
        [inserted.id, error.code || "VERIFICATION_FAILED"],
      );
    }
    throw error;
  }
}

export function webhookRoutes({ db, paypal, card }) {
  const router = Router();
  router.post(
    "/paypal",
    asyncRoute(async (req, res) => {
      const event = req.body;
      if (!event?.id)
        throw new HttpError(
          400,
          "WEBHOOK_INVALID",
          "Webhook event ID is required.",
        );
      if (!(await paypal.verifyWebhook(req.headers, event)))
        throw new HttpError(
          401,
          "WEBHOOK_SIGNATURE_INVALID",
          "PayPal signature verification failed.",
        );
      if (event.event_type !== "PAYMENT.CAPTURE.COMPLETED")
        return ok(
          res,
          await applyVerifiedPayment(db, res, {
            provider: "paypal",
            eventId: event.id,
            eventType: event.event_type,
            payload: event,
            verified: { successful: false },
          }),
        );
      const captureId = event.resource?.id;
      if (!captureId)
        throw new HttpError(
          400,
          "WEBHOOK_INVALID",
          "PayPal capture ID is required.",
        );
      const verified = await paypal.verifyCapture(captureId);
      ok(
        res,
        await applyVerifiedPayment(db, res, {
          provider: "paypal",
          eventId: event.id,
          eventType: event.event_type,
          payload: event,
          verified,
        }),
      );
    }),
  );
  router.post(
    "/card",
    asyncRoute(async (req, res) => {
      const signature = req.get("x-paystack-signature");
      if (!card.verifySignature(req.rawBody, signature))
        throw new HttpError(
          401,
          "WEBHOOK_SIGNATURE_INVALID",
          "Card-provider signature verification failed.",
        );
      const event = req.body;
      const eventId = String(event.data?.id || "");
      if (!eventId)
        throw new HttpError(
          400,
          "WEBHOOK_INVALID",
          "Webhook event ID is required.",
        );
      const verified =
        event.event === "charge.success"
          ? await card.verifyTransaction(event.data.reference)
          : { successful: false };
      ok(
        res,
        await applyVerifiedPayment(db, res, {
          provider: "card_provider",
          eventId,
          eventType: event.event,
          payload: event,
          verified,
        }),
      );
    }),
  );
  return router;
}

export { applyVerifiedPayment };
