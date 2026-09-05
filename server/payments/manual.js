import { HttpError } from "../http.js";

export const manualProvider = {
  methods: new Set(["paypal", "cash_app", "chime", "bank_transfer", "gift_card"]),
  create() {
    return {
      status: "awaiting_payment_details",
      instructions:
        "Submit payment using the displayed business details. Evidence is optional and never confirms receipt.",
    };
  },
  verify() {
    throw new HttpError(
      400,
      "MANUAL_REVIEW_REQUIRED",
      "An authorised administrator must confirm money in the business account.",
    );
  },
};
