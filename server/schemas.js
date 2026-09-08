import { z } from "zod";
export const uuid = z.string().uuid();
export const passwordPolicy = z
  .string()
  .min(8)
  .max(128)
  .refine((value) => /[A-Za-z]/.test(value), "Add at least one letter.")
  .refine((value) => /[0-9]/.test(value), "Add at least one number.");
export const credentials = z.object({
  email: z.string().email().max(254),
  password: passwordPolicy,
});
export const strongPassword = passwordPolicy;
export const recoveryPhone = z.string().trim().transform((value, context) => {
  const normalized = value.replace(/[\s()-]/g, "");
  if (!/^\+?[0-9]{7,20}$/.test(normalized)) {
    context.addIssue({ code: "custom", message: "Enter a valid recovery phone number." });
    return z.NEVER;
  }
  return normalized;
});
export const phoneCountry = z.string().trim().min(2).max(100);
export const profile = z.object({
  fullName: z.string().min(2).max(120),
  phone: z.string().max(30).optional(),
  country: phoneCountry.optional(),
});
export const eventInput = z.object({
  title: z.string().min(2).max(160),
  description: z.string().max(5000).default(""),
  venue: z.string().min(2).max(200),
  city: z.string().min(2).max(100),
  country: phoneCountry,
  startsAt: z.string().datetime(),
  currency: z
    .string()
    .length(3)
    .transform((v) => v.toUpperCase()),
});
export const sectionInput = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(1000).default(""),
  priceMinor: z.number().int().positive(),
  availableQuantity: z.number().int().nonnegative(),
});
export const eventWithSectionInput = eventInput.extend({
  section: sectionInput,
});
export const orderInput = z.object({
  eventId: uuid,
  sectionId: uuid,
  quantity: z.number().int().min(1).max(10),
  paymentMethod: z.enum(["paypal", "cash_app", "chime", "bank_transfer", "gift_card"]),
  contactName: z.string().min(2).max(120),
  contactEmail: z.string().email().max(254),
  contactPhone: z.string().trim().min(7).max(20).optional(),
  contactCountry: phoneCountry.optional(),
});
export const membershipInput = z.object({
  fullName: z.string().min(2).max(120),
  email: z.string().email(),
  country: z.string().length(2),
  reason: z.string().min(10).max(3000),
  interest: z.enum([
    "exclusive_content",
    "meet_and_greet",
    "merchandise",
    "general_membership",
  ]),
});
export const newsletterInput = z.object({
  email: z
    .string()
    .trim()
    .transform((value) => value.toLowerCase())
    .pipe(z.string().email().max(254)),
});
export const serviceInput = z.object({
  category: z.enum([
    "private_event",
    "appearance",
    "meet_and_greet",
    "general",
  ]),
  fullName: z.string().min(2).max(120),
  email: z.string().email(),
  phone: z.string().max(30).optional(),
  message: z.string().min(10).max(5000),
});
export const supportInput = z.object({
  name: z.string().min(2).max(120),
  email: z.string().email(),
  orderReference: z.string().max(40).optional(),
  message: z.string().min(10).max(5000),
  website: z.string().max(0).optional(),
});
export function parse(schema, value) {
  const result = schema.safeParse(value);
  if (!result.success) {
    const error = new Error("Request validation failed.");
    error.status = 400;
    error.code = "VALIDATION_ERROR";
    error.details = result.error.flatten();
    throw error;
  }
  return result.data;
}
