import { HttpError } from "../http.js";

export function createBrevoMailer(config, fetchImpl = globalThis.fetch) {
  const enabled = Boolean(
    config.EMAIL_PROVIDER === "brevo" &&
      config.BREVO_API_KEY &&
      config.BREVO_SENDER_EMAIL &&
      config.BREVO_SENDER_NAME,
  );
  async function send({ to, subject, text }) {
    if (!enabled) {
      if (config.NODE_ENV === "production")
        throw new HttpError(503, "EMAIL_UNAVAILABLE", "Security email delivery is unavailable.");
      return { mocked: true };
    }
    const response = await fetchImpl("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "content-type": "application/json", "api-key": config.BREVO_API_KEY },
      body: JSON.stringify({
        sender: { email: config.BREVO_SENDER_EMAIL, name: config.BREVO_SENDER_NAME },
        to: [{ email: to }],
        subject,
        textContent: text,
      }),
    });
    if (!response.ok)
      throw new HttpError(502, "EMAIL_DELIVERY_FAILED", "Security email delivery failed.");
    return { mocked: false };
  }
  return {
    enabled,
    sendAdminOtp({ to, otp, ttlMinutes }) {
      return send({
        to,
        subject: "Administrator password verification code",
        text: `Your administrator verification code is ${otp}. It expires in ${ttlMinutes} minutes. If you did not request this, contact the account owner immediately.`,
      });
    },
    sendPasswordChanged({ to }) {
      return send({
        to,
        subject: "Administrator password changed",
        text: "Your administrator password was changed and previous sessions were revoked. If this was not you, contact the account owner immediately.",
      });
    },
    sendTestEmail({ to }) {
      return send({
        to,
        subject: "Live Events administrator email test",
        text: "This is a harmless delivery test for the Live Events administrator security-email configuration. No action is required.",
      });
    },
  };
}
