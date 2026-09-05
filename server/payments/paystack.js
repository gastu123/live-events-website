import crypto from "node:crypto";
import { HttpError } from "../http.js";

export function createPaystackAdapter(config, fetchImpl = fetch) {
  const request = async (path, options = {}) => {
    const secret =
      config.PAYSTACK_SECRET_KEY || config.CARD_PROVIDER_SECRET_KEY;
    if (!config.PAYSTACK_ENABLED || !secret)
      throw new HttpError(
        503,
        "CARD_PROVIDER_NOT_CONFIGURED",
        "Hosted card checkout credentials are not configured.",
      );
    const response = await fetchImpl(`https://api.paystack.co${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.status === false)
      throw new HttpError(
        502,
        "CARD_PROVIDER_ERROR",
        "The hosted card provider request failed.",
      );
    return body.data;
  };
  return {
    async create({
      orderReference,
      amountMinor,
      currency,
      email,
      callbackUrl,
    }) {
      return request("/transaction/initialize", {
        method: "POST",
        body: JSON.stringify({
          email,
          amount: amountMinor,
          currency,
          reference: `PST-${crypto.randomBytes(10).toString("hex")}`,
          callback_url: callbackUrl,
          channels: ["card"],
          metadata: { order_reference: orderReference },
        }),
      });
    },
    verifySignature(rawBody, signature) {
      if (
        !(config.PAYSTACK_SECRET_KEY || config.CARD_PROVIDER_WEBHOOK_SECRET) ||
        !rawBody ||
        !signature ||
        !/^[a-f0-9]{128}$/i.test(signature)
      )
        return false;
      const expected = crypto
        .createHmac(
          "sha512",
          config.PAYSTACK_SECRET_KEY || config.CARD_PROVIDER_WEBHOOK_SECRET,
        )
        .update(rawBody)
        .digest("hex");
      return crypto.timingSafeEqual(
        Buffer.from(expected, "hex"),
        Buffer.from(signature, "hex"),
      );
    },
    async verifyTransaction(reference) {
      const data = await request(
        `/transaction/verify/${encodeURIComponent(reference)}`,
      );
      return {
        successful: data.status === "success",
        providerReference: String(data.id),
        lookupReference: data.reference,
        orderReference: data.metadata?.order_reference,
        amountMinor: Number(data.amount),
        currency: data.currency,
      };
    },
  };
}
