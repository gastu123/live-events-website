import { HttpError } from "../http.js";

export function createPayPalAdapter(config, fetchImpl = fetch) {
  const baseUrl =
    config.PAYPAL_ENV === "live"
      ? "https://api-m.paypal.com"
      : "https://api-m.sandbox.paypal.com";
  let cachedToken = null;
  let tokenExpiresAt = 0;
  async function accessToken(forceRefresh = false) {
    if (
      !config.PAYPAL_ENABLED ||
      !config.PAYPAL_CLIENT_ID ||
      !config.PAYPAL_CLIENT_SECRET
    )
      throw new HttpError(
        503,
        "PAYPAL_NOT_CONFIGURED",
        "PayPal sandbox credentials are not configured.",
      );
    if (!forceRefresh && cachedToken && Date.now() < tokenExpiresAt)
      return cachedToken;
    const response = await fetchImpl(`${baseUrl}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${config.PAYPAL_CLIENT_ID}:${config.PAYPAL_CLIENT_SECRET}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });
    if (!response.ok)
      throw new HttpError(
        502,
        "PAYPAL_AUTH_FAILED",
        "PayPal authentication failed.",
      );
    const body = await response.json();
    cachedToken = body.access_token;
    tokenExpiresAt =
      Date.now() + Math.max(1, Number(body.expires_in || 300) - 30) * 1000;
    return cachedToken;
  }
  async function paypalFetch(path, options = {}) {
    let token = await accessToken();
    let response = await fetchImpl(`${baseUrl}${path}`, {
      ...options,
      headers: { ...(options.headers || {}), Authorization: `Bearer ${token}` },
    });
    if (response.status === 401) {
      token = await accessToken(true);
      response = await fetchImpl(`${baseUrl}${path}`, {
        ...options,
        headers: {
          ...(options.headers || {}),
          Authorization: `Bearer ${token}`,
        },
      });
    }
    return response;
  }
  return {
    async create({
      orderReference,
      amountMinor,
      currency,
      idempotencyKey,
      returnUrl,
      cancelUrl,
    }) {
      const response = await paypalFetch("/v2/checkout/orders", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "PayPal-Request-Id": idempotencyKey,
        },
        body: JSON.stringify({
          intent: "CAPTURE",
          purchase_units: [
            {
              reference_id: orderReference,
              custom_id: orderReference,
              amount: {
                currency_code: currency,
                value: (amountMinor / 100).toFixed(2),
              },
            },
          ],
          payment_source: {
            paypal: {
              experience_context: {
                return_url: returnUrl,
                cancel_url: cancelUrl,
                user_action: "PAY_NOW",
              },
            },
          },
        }),
      });
      if (!response.ok)
        throw new HttpError(
          502,
          "PAYPAL_CREATE_FAILED",
          "PayPal could not create the payment request.",
        );
      return response.json();
    },
    async captureOrder(providerOrderId, idempotencyKey) {
      const response = await paypalFetch(
        `/v2/checkout/orders/${encodeURIComponent(providerOrderId)}/capture`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "PayPal-Request-Id": idempotencyKey,
          },
        },
      );
      if (!response.ok)
        throw new HttpError(
          502,
          "PAYPAL_CAPTURE_FAILED",
          "PayPal could not complete the authorised payment.",
        );
      return response.json();
    },
    async verifyWebhook(headers, event) {
      const response = await paypalFetch(
        "/v1/notifications/verify-webhook-signature",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            auth_algo: headers["paypal-auth-algo"],
            cert_url: headers["paypal-cert-url"],
            transmission_id: headers["paypal-transmission-id"],
            transmission_sig: headers["paypal-transmission-sig"],
            transmission_time: headers["paypal-transmission-time"],
            webhook_id: config.PAYPAL_WEBHOOK_ID,
            webhook_event: event,
          }),
        },
      );
      return (
        response.ok && (await response.json()).verification_status === "SUCCESS"
      );
    },
    async verifyCapture(captureId) {
      const response = await paypalFetch(
        `/v2/payments/captures/${encodeURIComponent(captureId)}`,
      );
      if (!response.ok)
        throw new HttpError(
          502,
          "PAYPAL_VERIFY_FAILED",
          "PayPal capture verification failed.",
        );
      const capture = await response.json();
      return {
        successful: capture.status === "COMPLETED",
        providerReference: capture.id,
        lookupReference: capture.supplementary_data?.related_ids?.order_id,
        orderReference: capture.custom_id || capture.invoice_id,
        amountMinor: Math.round(Number(capture.amount?.value) * 100),
        currency: capture.amount?.currency_code,
      };
    },
  };
}
