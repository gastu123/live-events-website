document.addEventListener("DOMContentLoaded", () => {
  const configuredApiBase = document.querySelector('meta[name="public-api-base-url"]')?.content.trim();
  const apiBase = configuredApiBase && configuredApiBase !== "__PUBLIC_API_BASE_URL__" ? configuredApiBase.replace(/\/$/, "") : "";
  const isCombinedLocalPreview =
    globalThis.location.hostname === "localhost" &&
    globalThis.location.pathname === "/";
  if (
    "serviceWorker" in navigator &&
    !isCombinedLocalPreview
  ) {
    const scope = globalThis.location.pathname.startsWith("/public-site/")
      ? "/public-site/"
      : "/";
    navigator.serviceWorker.register("./public-sw.js", { scope }).catch(() => {});
  }
  let deferredInstallPrompt = null;
  const installButtons = [...document.querySelectorAll('[data-action="install-pwa"]')];
  const setInstallButtonsVisible = (visible) =>
    installButtons.forEach((button) => (button.hidden = !visible));
  window.addEventListener("beforeinstallprompt", (event) => {
    if (isCombinedLocalPreview) return;
    event.preventDefault();
    deferredInstallPrompt = event;
    setInstallButtonsVisible(true);
  });
  window.addEventListener("appinstalled", () => {
    deferredInstallPrompt = null;
    setInstallButtonsVisible(false);
  });
  installButtons.forEach((button) =>
    button.addEventListener("click", async () => {
      if (!deferredInstallPrompt) {
        showInstallInstructions();
        return;
      }
      await deferredInstallPrompt.prompt();
      const choice = await deferredInstallPrompt.userChoice;
      deferredInstallPrompt = null;
      if (choice?.outcome === "accepted") setInstallButtonsVisible(false);
    }),
  );
  function showInstallInstructions() {
    const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
    const isSafari = /safari/i.test(navigator.userAgent) && !/crios|fxios|edgios/i.test(navigator.userAgent);
    const description = isIos && isSafari
      ? "In Safari, tap Share, then Add to Home Screen to install Live Events."
      : isCombinedLocalPreview
        ? "Open the deployed public website over HTTPS, then use your browser's install option. The combined local preview cannot install the customer app because it also hosts Admin."
        : "Open your browser menu and choose Install App or Add to Home Screen to install Live Events.";
    const dialog = make("div", { class: "app-dialog", role: "dialog", "aria-modal": "true" });
    const close = () => dialog.remove();
    const card = make(
      "div",
      { class: "app-dialog-card" },
      make("h2", { text: "Install Live Events" }),
      make("p", { text: description }),
    );
    const closeButton = make("button", { class: "button button-primary", type: "button", text: "Close" });
    closeButton.addEventListener("click", close);
    card.append(make("div", { class: "app-dialog-actions" }, closeButton));
    const backdrop = make("button", { class: "app-dialog-backdrop", type: "button", "aria-label": "Close" });
    backdrop.addEventListener("click", close);
    dialog.append(backdrop, card);
    document.body.append(dialog);
    closeButton.focus();
  }
  const pages = [...document.querySelectorAll("[data-page]")];
  const routeControls = [...document.querySelectorAll("[data-route]")];
  const navLinks = [...document.querySelectorAll(".nav-link")];
  const mobileMenu = document.getElementById("mobile-menu");
  const menuButton = document.querySelector('[data-action="toggle-menu"]');
  const searchDialog = document.getElementById("search-dialog");
  const toastRegion = document.getElementById("toast-region");
  const siteFooter = document.querySelector(".site-footer");

  const validRoutes = new Set(pages.map((page) => page.dataset.page));
  const protectedSuccessRoute = "success";
  let checkoutTimerId = null;
  let checkoutSeconds = 9 * 60 + 48;
  let csrfToken = "";
  const accountMenuButton = document.getElementById("account-menu-button");
  const accountAuthCard = document.getElementById("account-auth-card");
  function paymentMethodLabel(method) {
    return { gift_card: "Gift Card" }[method] || String(method || "payment").replaceAll("_", " ");
  }
  function setPaymentAttention(orders = []) {
    const attention = orders.filter((order) =>
      ["payment_details_ready", "pending_verification"].includes(order.current_payment_status),
    ).length;
    document.querySelectorAll("[data-payment-nav]").forEach((node) => {
      node.hidden = false;
    });
    document.querySelectorAll("[data-payment-badge]").forEach((badge) => {
      badge.hidden = attention === 0;
      badge.textContent = String(attention);
    });
  }
  function setMembershipStatus(applications = []) {
    const joined = applications.some(
      (application) => application.membership_status === "active",
    );
    document.querySelectorAll("[data-membership-cta]").forEach((button) => {
      button.textContent = joined ? "Joined" : "Join membership";
      button.dataset.route = joined ? "account" : "membership";
      button.setAttribute("aria-label", joined ? "View your membership" : "Join membership");
    });
  }

  function setCustomerSession(profile = null) {
    if (accountAuthCard) accountAuthCard.hidden = Boolean(profile);
    if (accountMenuButton)
      accountMenuButton.textContent = profile?.full_name
        ? profile.full_name.split(/\s+/)[0]
        : "Profile";
    if (accountMenuButton) accountMenuButton.hidden = !profile;
    document.querySelectorAll('[data-account-nav="login"]').forEach((node) => {
      node.hidden = Boolean(profile);
    });
    document.querySelectorAll('[data-account-nav="profile"]').forEach((node) => {
      node.hidden = !profile;
    });
    document.querySelectorAll("[data-payment-nav]").forEach((node) => {
      node.hidden = !profile;
    });
    const title = document.getElementById("account-title");
    if (title)
      title.textContent = profile
        ? `Welcome, ${profile.full_name || "member"}.`
        : "Your live experiences, all together.";
  }

  async function api(path, options = {}) {
    const headers = {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    };
    if (csrfToken) headers["X-CSRF-Token"] = csrfToken;
    const response = await fetch(`${apiBase}/api/v1${path}`, {
      credentials: "include",
      ...options,
      headers,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok)
      throw new Error(
        payload.error?.message || "Request failed. Please try again.",
      );
    return payload.data;
  }
  function paymentDetailNodes(data) {
    const nodes = [
      make("strong", { text: `${displayMoney(data.amount_minor, data.currency)} • ${paymentMethodLabel(data.payment_method)}` }),
    ];
    if (data.payment_method === "bank_transfer") {
      nodes.push(
        make("p", { text: `Bank: ${data.bank_name}` }),
        make("p", { text: `Account name: ${data.account_name}` }),
        make("p", { text: `Account number: ${data.account_number}` }),
      );
    } else if (data.payment_method === "gift_card") {
      nodes.push(make("p", { text: data.instructions || "Provide your gift card proof." }));
    } else {
      nodes.push(make("p", { text: data.payment_identifier }));
    }
    if (data.payment_method !== "gift_card")
      nodes.push(make("p", { text: `Payment reference: ${data.payment_reference}` }));
    if (data.payment_method !== "gift_card" && data.instructions && String(data.instructions).trim().toLowerCase() !== "null")
      nodes.push(make("p", { text: data.instructions }));
    return nodes;
  }

  async function loadAccountOrders() {
    const container = document.getElementById("account-order-list");
    const status = document.getElementById("account-status");
    if (!container || !status) return;
    container.replaceChildren();
    const loading = document.createElement("p");
    loading.textContent = "Loading order status…";
    container.append(loading);
    status.hidden = false;
    try {
      const [profile, notifications, orders, applications, services] =
        await Promise.all([
        api("/auth/me"),
        api("/account/notifications"),
        api("/account/orders"),
        api("/account/membership-applications"),
        api("/account/service-requests"),
        ]);
      container.replaceChildren();
      setCustomerSession(profile);
      setMembershipStatus(applications);
      setPaymentAttention(orders);
      const accountNotifications = notifications.filter(
        (notification) => !["payment_details_ready", "manual_verification"].includes(notification.kind),
      );
      const profileForm = make(
        "form",
        { class: "drawer-form" },
        make("h3", { text: "Profile" }),
        make(
          "label",
          {},
          "Full name",
          make("input", {
            name: "fullName",
            value: profile.full_name || "",
            required: true,
          }),
        ),
        make(
          "label",
          {},
          "Phone Number",
          make("input", { name: "phone", value: profile.phone || "", inputMode: "tel" }),
        ),
        countryField("country", profile.country, "countryName"),
        make("button", {
          class: "button button-outline",
          type: "submit",
          text: "Save profile",
        }),
      );
      profileForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        const values = new FormData(profileForm);
        try {
          await api("/auth/me", {
            method: "PATCH",
            body: JSON.stringify({
              fullName: values.get("fullName"),
              phone: values.get("phone") || undefined,
              country: values.get("country") === "OTHER"
                ? String(values.get("countryName") || "").trim()
                : String(values.get("country") || "").toUpperCase() || undefined,
            }),
          });
          showToast("Profile updated.", "success");
        } catch (error) {
          showToast(error.message, "error");
        }
      });
      container.append(
        profileForm,
        make("h3", { text: "Notifications" }),
        ...(accountNotifications.length
          ? accountNotifications.map((notification) =>
              make("article", { class: "panel" },
                make("strong", { text: notification.title }),
                make("p", { text: notification.body }),
                make("small", {
                  text: new Date(notification.created_at).toLocaleString(),
                }),
              ),
            )
          : [make("p", { text: "No notifications yet." })]),
        make("h3", { text: "Orders" }),
      );
      if (!orders.length) {
        const empty = document.createElement("p");
        empty.textContent = "No order requests yet.";
        container.append(empty);
      }
      const ordersByPaymentId = new Map(orders.map((order) => [order.payment_id, order]));
      container.onclick = async (event) => {
        const control = event.target.closest("[data-payment-action]");
        if (!control) return;
        const order = ordersByPaymentId.get(control.dataset.paymentId);
        if (!order) return;
        if (control.dataset.paymentAction === "details") {
          try {
            const data = await api(`/account/payments/${order.payment_id}/instructions`);
            showPaymentDetails(order, data);
          } catch (error) {
            showToast(error.message, "error");
          }
        }
        if (control.dataset.paymentAction === "submit") {
          try {
            await submitManualPayment(order);
          } catch (error) {
            showToast(error.message, "error");
          }
        }
      };
      for (const order of []) {
        const item = make("article", { class: "panel" });
        const reference = document.createElement("strong");
        reference.textContent = `${order.reference} • ${displayMoney(order.total_minor, order.currency)} • ${String(order.method || "payment").replaceAll("_", " ")}`;
        const message = document.createElement("p");
        const stateMessages = {
          awaiting_payment_details:
            "Preparing your payment details. An administrator has been notified and your payment instructions will appear here shortly.",
          payment_details_ready:
            "Your payment details are ready. Transfer the exact amount using the reference below before the instructions expire.",
          pending_verification:
            "Payment submitted. Verification is in progress.",
          successful: "Payment successful. Your payment has been confirmed.",
          rejected:
            "Payment could not be approved. Review the payment details or contact support for help.",
          payment_details_expired:
            "Payment instructions expired. Request fresh instructions to continue this order.",
        };
        message.textContent =
          stateMessages[order.current_payment_status] ||
          "Your order has been received and is awaiting payment verification.";
        item.append(
          make("p", { class: "eyebrow", text: order.current_payment_status === "payment_details_ready" ? "PENDING PAYMENT" : order.current_payment_status === "pending_verification" ? "PAYMENT VERIFICATION PENDING" : order.current_payment_status === "successful" ? "PAYMENT SUCCESSFUL" : "ORDER PAYMENT" }),
          make("h3", { text: order.event_title || "Order payment" }),
          make("p", { class: "panel-description", text: `${order.event_venue || ""}${order.event_city ? ` • ${order.event_city}` : ""}${order.event_starts_at ? ` • ${new Date(order.event_starts_at).toLocaleString()}` : ""}` }),
          reference,
          message,
        );
        if (order.current_payment_status === "payment_details_ready") {
          const details = make("button", {
            class: "button button-outline button-small",
            type: "button",
            text: "Make Payment / View Payment Details",
            "data-payment-action": "details",
            "data-payment-id": order.payment_id,
          });
          const assignedDetails = make(
            "div",
            { class: "payment-assigned-details" },
            make("p", { class: "panel-description", text: "Loading assigned payment details…" }),
          );
          item.append(assignedDetails, details);
          api(`/account/payments/${order.payment_id}/instructions`)
            .then((data) => assignedDetails.replaceChildren(
              make("strong", { text: `${displayMoney(data.amount_minor, data.currency)} • ${paymentMethodLabel(data.payment_method)}` }),
              make("p", { text: `${data.account_name} • ${data.payment_identifier}` }),
              make("p", { text: `Reference: ${data.payment_reference}` }),
              data.instructions && data.instructions !== "null" ? make("p", { text: data.instructions }) : null,
            ))
            .catch((error) => assignedDetails.replaceChildren(make("p", { class: "status danger", text: error.message })));
        }
        if (order.current_payment_status === "payment_details_expired") {
          const refresh = make("button", {
            class: "button button-outline button-small",
            type: "button",
            text: "Request fresh instructions",
          });
          refresh.addEventListener("click", async () => {
            try {
              const data = await api(
                `/account/payments/${order.payment_id}/request-fresh-instructions`,
                { method: "POST" },
              );
              showToast(data.message, "success");
              await loadAccountOrders();
            } catch (error) {
              showToast(error.message, "error");
            }
          });
          item.append(refresh);
        }
        if (order.current_payment_status === "payment_details_ready") {
          const evidence = make("button", {
            class: "button button-outline button-small",
            type: "button",
            text: "I Have Made the Payment",
            "data-payment-action": "submit",
            "data-payment-id": order.payment_id,
          });
          item.append(evidence);
        }
        container.append(item);
      }
      container.append(
        make("h3", { text: "Membership applications" }),
        ...(applications.length
          ? applications.map((row) =>
              make("p", {
                text: `${new Date(row.created_at).toLocaleDateString()} • ${row.status.replaceAll("_", " ")}`,
              }),
            )
          : [make("p", { text: "No membership applications." })]),
        make("h3", { text: "Service requests" }),
        ...(services.length
          ? services.map((row) =>
              make("p", {
                text: `${row.category.replaceAll("_", " ")} • ${row.status.replaceAll("_", " ")}`,
              }),
            )
          : [make("p", { text: "No service requests." })]),
      );
    } catch (error) {
      container.replaceChildren();
      const message = document.createElement("p");
      message.textContent = error.message;
      container.append(message);
    }
  }

  async function loadPaymentCenter() {
    const list = document.getElementById("payment-center-list");
    const status = document.getElementById("payment-center-status");
    if (!list || !status) return;
    list.replaceChildren(make("p", { text: "Loading payment status…" }));
    status.replaceChildren();
    try {
      const [profile, orders] = await Promise.all([
        api("/auth/me"),
        api("/account/orders"),
      ]);
      setCustomerSession(profile);
      setPaymentAttention(orders);
      const actionable = orders.filter((order) =>
        ["payment_details_ready", "pending_verification", "successful", "rejected"].includes(order.current_payment_status),
      );
      list.replaceChildren();
      if (!actionable.length) {
        status.append(make("article", { class: "payment-notice" },
          make("strong", { text: "No payment action required" }),
          make("p", { text: "Payment notifications for this account will appear here when an administrator assigns payment details." }),
        ));
        list.append(make("p", { class: "panel-description", text: "No payments need your attention right now." }));
        return;
      }
      const paymentRequired = actionable.some((order) => order.current_payment_status === "payment_details_ready");
      const verificationPending = actionable.some((order) => order.current_payment_status === "pending_verification");
      const paymentSuccessful = actionable.some((order) => order.current_payment_status === "successful");
      const notice = verificationPending
        ? ["Payment Verification Pending", "Your payment has been submitted and is awaiting verification."]
        : paymentRequired
          ? ["Payment Required", "Your payment details are ready. Please complete your payment and submit your payment proof for verification."]
          : paymentSuccessful
            ? ["Payment Successful", "Your payment has been confirmed."]
            : ["Payment Update", "Please review your payment status below."];
      status.append(make("article", { class: "payment-notice" },
        make("strong", { text: notice[0] }),
        make("p", { text: notice[1] }),
      ));
      for (const order of actionable) {
        const card = make("article", { class: "panel payment-center-card" });
        const state = order.current_payment_status;
        card.append(
          make("p", { class: "eyebrow", text: state === "payment_details_ready" ? "PAYMENT REQUIRED" : state === "pending_verification" ? "PAYMENT VERIFICATION PENDING" : state === "successful" ? "PAYMENT SUCCESSFUL" : "PAYMENT UPDATE" }),
          make("h2", { text: order.event_title || "Order payment" }),
          make("p", { class: "panel-description", text: `${order.event_venue || ""}${order.event_city ? ` • ${order.event_city}` : ""}${order.event_starts_at ? ` • ${new Date(order.event_starts_at).toLocaleString()}` : ""}` }),
          make("strong", { text: `${order.reference} • ${displayMoney(order.total_minor, order.currency)} • ${paymentMethodLabel(order.method)}` }),
        );
        if (state === "payment_details_ready") {
          const details = make("div", { class: "payment-assigned-details" }, make("p", { text: "Loading assigned payment details…" }));
          const view = make("button", { class: "button button-outline button-small", type: "button", text: "View Payment Details" });
          const verify = make("button", { class: "button button-primary button-small", type: "button", text: "I've Made the Payment" });
          const openDetails = async (showModal = false) => {
            try {
              const data = await api(`/account/payments/${order.payment_id}/instructions`);
              details.replaceChildren(...paymentDetailNodes(data));
              if (showModal) showPaymentDetails(order, data);
            } catch (error) { showToast(error.message, "error"); }
          };
          view.addEventListener("click", () => openDetails(true));
          verify.addEventListener("click", () => submitManualPayment(order).catch((error) => showToast(error.message, "error")));
          card.append(details, make("div", { class: "payment-card-actions" }, view, verify));
          openDetails();
        } else if (state === "pending_verification") {
          card.append(make("p", { text: "Payment Verification Pending. You cannot submit another verification while this payment is under review." }));
        } else if (state === "successful") {
          card.append(make("p", { text: "Payment Successful" }));
        } else {
          card.append(make("p", { text: "Payment needs attention. Please review your payment status." }));
        }
        list.append(card);
      }
    } catch (error) {
      setPaymentAttention([]);
      list.replaceChildren(make("p", { class: "status danger", text: error.message }));
    }
  }

  const currencySymbols = {
    USD: "$",
    GBP: "£",
    EUR: "€",
    CAD: "CA$",
  };

  const state = {
    route: "home",
    ticketQuantity: 1,
    ticketPrice: 0,
    ticketSection: "",
    currency: "USD",
    paymentMethod: "paypal",
    orderNumber: "",
    eventId: "",
    sectionId: "",
    checkoutKey: "",
  };

  const make = (tag, attrs = {}, ...children) => {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (value == null) continue;
      if (key === "class") node.className = value;
      else if (key === "text") node.textContent = value;
      else if (key.startsWith("data-")) node.setAttribute(key, value);
      else if (key in node) node[key] = value;
      else node.setAttribute(key, value);
    }
    for (const child of children.flat())
      if (child != null)
        node.append(
          child.nodeType ? child : document.createTextNode(String(child)),
        );
    return node;
  };
  function countryField(name, currentValue, manualName) {
    const knownCountries = ["NG", "US", "GB", "CA"];
    const selectedValue = knownCountries.includes(currentValue) ? currentValue : currentValue ? "OTHER" : "";
    const select = make("select", { name });
    [["", "Select country"], ["NG", "Nigeria"], ["US", "United States"], ["GB", "United Kingdom"], ["CA", "Canada"], ["OTHER", "Other"]].forEach(([value, text]) => select.append(make("option", { value, text, selected: value === selectedValue })));
    const manual = make("label", { hidden: selectedValue !== "OTHER" }, "Enter your country", make("input", { name: manualName, value: selectedValue === "OTHER" ? currentValue : "" }));
    select.addEventListener("change", () => { manual.hidden = select.value !== "OTHER"; if (select.value !== "OTHER") manual.querySelector("input").value = ""; });
    return make("div", { class: "country-field" }, make("label", {}, "Country", select), manual);
  }
  document.querySelectorAll('select[name="phone-country"], select[name="member-country"]').forEach((select) => {
    const field = select.closest("label")?.parentElement?.querySelector("[data-other-country-field]");
    if (!field) return;
    const input = field.querySelector("input");
    const update = () => { field.hidden = select.value !== "OTHER"; input.required = select.value === "OTHER"; };
    select.addEventListener("change", update);
    update();
  });
  function openAccountDialog({ title, description, fields, submitLabel = "Save", onSubmit }) {
    return new Promise((resolve) => {
      const dialog = make("div", { class: "app-dialog", role: "dialog", "aria-modal": "true" });
      const close = (value = null) => { dialog.remove(); resolve(value); };
      const message = make("p", { text: description });
      const form = make("form", { class: "app-dialog-card" }, make("h2", { text: title }), message);
      fields.forEach(({ name, label, type = "text", required = false, accept }) => {
        const input = make("input", { name, type, required, accept });
        if (type === "password") {
          input.minLength = 8;
          input.pattern = "(?=.*[A-Za-z])(?=.*[0-9]).{8,}";
          input.title = "Use at least 8 characters, including a letter and a number.";
        }
        const field = make("label", {}, label, input);
        if (type === "file") {
          const fileName = make("small", { class: "file-name", text: "No file selected" });
          input.addEventListener("change", () => {
            fileName.textContent = input.files?.[0]?.name || "No file selected";
          });
          field.append(fileName);
        }
        form.append(field);
      });
      const cancel = make("button", { class: "button button-outline", type: "button", text: "Cancel" });
      cancel.addEventListener("click", () => close());
      const submit = make("button", { class: "button button-primary", type: "submit", text: submitLabel });
      form.append(make("div", { class: "app-dialog-actions" }, cancel, submit));
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (!form.reportValidity()) return;
        const values = new FormData(form);
        if (!onSubmit) return close(values);
        submit.disabled = true;
        cancel.disabled = true;
        submit.textContent = "Submitting...";
        try {
          await onSubmit(values);
          close(values);
        } catch (error) {
          message.textContent = error.message;
          message.className = "dialog-error";
          submit.disabled = false;
          cancel.disabled = false;
          submit.textContent = submitLabel;
        }
      });
      const backdrop = make("button", { class: "app-dialog-backdrop", type: "button", "aria-label": "Cancel" });
      backdrop.addEventListener("click", () => close());
      dialog.append(backdrop, form);
      document.body.append(dialog);
      form.querySelector("input")?.focus();
    });
  }
  async function submitManualPayment(order) {
    const isGiftCard = order.method === "gift_card";
    const values = await openAccountDialog({
      title: "Verify Your Payment",
      description: isGiftCard ? "Provide either a photo of the gift card or its code so our team can verify your payment." : "Upload your payment receipt or proof of payment so our team can verify your payment.",
      submitLabel: "Submit Payment for Verification",
      fields: isGiftCard ? [
        { name: "giftCardImage", label: "Gift card image or photo (optional)", type: "file", accept: "image/png,image/jpeg,image/webp" },
        { name: "giftCardCode", label: "Gift card code (optional)" },
      ] : [
        { name: "receipt", label: "Payment proof or receipt", type: "file", required: true, accept: "image/png,image/jpeg,image/webp,application/pdf" },
      ],
      onSubmit: async (submittedValues) => {
        const file = submittedValues.get(isGiftCard ? "giftCardImage" : "receipt");
        const giftCardCode = String(submittedValues.get("giftCardCode") || "").trim();
        if (isGiftCard && !giftCardCode && (!file || typeof file !== "object" || !file.size))
          throw new Error("Provide a gift card image or enter the gift card code.");
        if (!isGiftCard && (!file || typeof file !== "object" || !file.size))
          throw new Error("Upload payment proof before submitting for verification.");
        let evidenceStoragePath = null;
        if (file && typeof file === "object" && file.size) {
          const upload = await api(`/account/payments/${order.payment_id}/evidence-upload`, { method: "POST", body: JSON.stringify({ filename: file.name, contentType: file.type, size: file.size }) });
          const response = await fetch(upload.signedUrl, { method: "PUT", headers: { "Content-Type": file.type }, body: file });
          if (!response.ok) throw new Error("Evidence upload failed.");
          evidenceStoragePath = upload.path;
        }
        const submitted = await api(`/account/payments/${order.payment_id}/manual-submission`, { method: "POST", body: JSON.stringify({ evidenceStoragePath, giftCardCode: isGiftCard ? giftCardCode : undefined, note: "Customer supplied payment proof." }) });
        showToast(submitted.message, "success");
        await loadAccountOrders();
      },
    });
    return values;
  }
  function showPaymentDetails(order, details) {
    const dialog = document.getElementById("payment-details-dialog");
    const content = document.getElementById("payment-details-content");
    if (!dialog || !content) return;
    document.getElementById("payment-details-order").textContent = `${order.event_title} • ${order.reference}`;
    content.replaceChildren(
      make("p", { text: `Amount: ${displayMoney(details.amount_minor, details.currency)}` }),
      make("p", { text: `Payment method: ${paymentMethodLabel(details.payment_method)}` }),
      ...(details.payment_method === "bank_transfer"
        ? [
            make("p", { text: `Bank: ${details.bank_name}` }),
            make("p", { text: `Account name: ${details.account_name}` }),
            make("p", { text: `Account number: ${details.account_number}` }),
          ]
        : details.payment_method === "gift_card"
          ? [make("p", { text: details.instructions || "Provide your gift card proof." })]
          : [make("p", { text: details.payment_identifier })]),
      details.payment_method !== "gift_card" ? make("p", { text: `Unique payment reference: ${details.payment_reference}` }) : null,
      make("p", { text: `Expires: ${new Date(details.expires_at).toLocaleString()}` }),
      details.payment_method !== "gift_card" && details.instructions && String(details.instructions).trim().toLowerCase() !== "null" ? make("p", { text: `Instructions: ${details.instructions}` }) : null,
    );
    dialog.hidden = false;
    dialog.paymentOrder = order;
  }
  document.querySelectorAll("[data-payment-dialog-close]").forEach((control) =>
    control.addEventListener("click", () => {
      document.getElementById("payment-details-dialog").hidden = true;
    }),
  );
  document.querySelector("[data-payment-dialog-submit]")?.addEventListener("click", () => {
    const dialog = document.getElementById("payment-details-dialog");
    dialog.hidden = true;
    if (dialog.paymentOrder)
      submitManualPayment(dialog.paymentOrder).catch((error) => showToast(error.message, "error"));
  });
  const displayMoney = (minor, currency) =>
    new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: currency || "USD",
      maximumFractionDigits: 2,
    }).format(Number(minor) / 100);
  function renderFeaturedEvents(events) {
    const grid = document.querySelector("#page-home .event-grid");
    if (!grid) return;
    grid.replaceChildren();
    for (const event of events.slice(0, 2)) {
      const starts = new Date(event.starts_at);
      const action = make("button", {
        class: "button button-primary button-small",
        type: "button",
        text: "View options",
      });
      action.addEventListener("click", () =>
        loadEventDetails(event.slug).catch((error) =>
          showToast(error.message, "error"),
        ),
      );
      grid.append(
        make(
          "article",
          { class: "event-card event-card-placeholder" },
          make(
            "div",
            { class: "event-placeholder" },
            make("span", { text: "LIVE" }),
          ),
          make(
            "div",
            { class: "event-card-content" },
            make("p", { class: "event-type", text: "Published event" }),
            make("h3", { text: event.title }),
            make(
              "dl",
              { class: "event-meta" },
              make(
                "div",
                {},
                make("dt", { text: "Date" }),
                make("dd", { text: starts.toLocaleString() }),
              ),
              make(
                "div",
                {},
                make("dt", { text: "Venue" }),
                make("dd", { text: `${event.venue}, ${event.city}` }),
              ),
            ),
            make(
              "div",
              { class: "event-card-footer" },
              make("p", {
                class: "event-price",
                text: `From ${displayMoney(event.starting_price_minor, event.currency)}`,
              }),
              action,
            ),
          ),
        ),
      );
    }
    if (!events.length)
      grid.append(
        make("p", {
          class: "muted",
          text: "No published events are currently available.",
        }),
      );
  }
  async function loadEventDetails(slug) {
    const event = await api(`/events/${encodeURIComponent(slug)}`);
    state.eventId = event.id;
    state.currency = event.currency;
    const title = document.getElementById("event-details-title");
    if (title) title.textContent = event.title;
    const detail = title?.nextElementSibling;
    if (detail)
      detail.textContent = `${event.venue} • ${event.city}, ${event.country}`;
    const list = document.querySelector(".ticket-option-list");
    if (list) {
      list.replaceChildren();
      if (!event.sections.length) {
        list.append(
          make("p", {
            class: "panel-description",
            text: "No ticket options are currently available for order requests.",
          }),
        );
      }
      event.sections.forEach((section, index) => {
        const input = make("input", {
          type: "radio",
          name: "ticket-option",
          value: section.id,
          checked: index === 0,
        });
        const label = make(
          "label",
          { class: `ticket-option${index === 0 ? " is-selected" : ""}` },
          input,
          make(
            "span",
            { class: "ticket-option-main" },
            make(
              "span",
              { class: "ticket-option-heading" },
              make("strong", { text: section.name }),
            ),
            make("span", {
              class: "ticket-benefits",
              text: section.description || "Order request section",
            }),
            make("span", {
              class: "scarcity",
              text: `${section.available_quantity} currently available`,
            }),
          ),
          make(
            "span",
            { class: "ticket-option-price" },
            make("small", { text: "Each" }),
            make("strong", {
              text: displayMoney(section.price_minor, event.currency),
            }),
            make("small", { text: "Server price" }),
          ),
        );
        input.addEventListener("change", () => {
          document
            .querySelectorAll(".ticket-option")
            .forEach((item) => item.classList.remove("is-selected"));
          label.classList.add("is-selected");
          state.sectionId = section.id;
          state.ticketPrice = Number(section.price_minor) / 100;
          state.ticketSection = section.name;
          state.checkoutKey = "";
          updateTicketSummary();
        });
        list.append(label);
        if (index === 0) {
          state.sectionId = section.id;
          state.ticketPrice = Number(section.price_minor) / 100;
          state.ticketSection = section.name;
        }
      });
      updateTicketSummary();
    }
    navigate("event-details");
  }
  async function loadPublicEvents(query = "", filters = {}) {
    const list = document.getElementById("event-list");
    if (!list) return;
    list.replaceChildren(make("p", { text: "Loading events…" }));
    try {
      const params = new URLSearchParams();
      if (query) params.set("q", query);
      if (filters.city) params.set("city", filters.city);
      if (filters.from) params.set("from", filters.from);
      if (filters.to) params.set("to", filters.to);
      const events = await api(`/events${params.size ? `?${params}` : ""}`);
      if (!query && !filters.city && !filters.from) {
        const citySelect = document.querySelector(
          '#event-filter-form select[name="city"]',
        );
        if (citySelect) {
          citySelect.replaceChildren(
            make("option", { value: "", text: "All cities" }),
          );
          for (const city of [
            ...new Set(events.map((event) => event.city)),
          ].sort())
            citySelect.append(make("option", { value: city, text: city }));
        }
      }
      if (!query) renderFeaturedEvents(events);
      list.replaceChildren();
      document.getElementById("event-count").textContent = String(
        events.length,
      );
      if (!events.length) {
        list.append(
          make("p", {
            class: "panel-description",
            text: "No published events match this search.",
          }),
        );
        return;
      }
      for (const event of events) {
        const starts = new Date(event.starts_at);
        const action = make("button", {
          class: "button button-primary button-small",
          type: "button",
          text: "View options",
        });
        action.addEventListener("click", async () => {
          action.disabled = true;
          try {
            await loadEventDetails(event.slug);
          } catch (error) {
            showToast(error.message, "error");
          } finally {
            action.disabled = false;
          }
        });
        list.append(
          make(
            "article",
            {
              class: "event-row",
              "data-city": event.city.toLowerCase().replaceAll(" ", "-"),
            },
            make(
              "div",
              { class: "date-block" },
              make("span", {
                text: starts
                  .toLocaleString(undefined, { month: "short" })
                  .toUpperCase(),
              }),
              make("strong", {
                text: String(starts.getDate()).padStart(2, "0"),
              }),
              make("small", {
                text: starts
                  .toLocaleString(undefined, { weekday: "short" })
                  .toUpperCase(),
              }),
            ),
            make(
              "div",
              { class: "event-row-main" },
              make("p", { class: "event-type", text: "Live event" }),
              make("h3", { text: event.title }),
              make("p", {
                text: `${starts.toLocaleString()} • ${event.venue}, ${event.city}`,
              }),
            ),
            make(
              "div",
              { class: "event-row-price" },
              make("span", { text: "From" }),
              make("strong", {
                text: displayMoney(event.starting_price_minor, event.currency),
              }),
            ),
            action,
          ),
        );
      }
    } catch (error) {
      list.replaceChildren(
        make("p", { class: "status danger", text: error.message }),
      );
    }
  }

  function routeFromHash() {
    const hashRoute = window.location.hash.replace(/^#/, "").trim();
    if (!hashRoute || !validRoutes.has(hashRoute)) return "home";
    if (hashRoute === protectedSuccessRoute && !state.orderNumber)
      return "home";
    return hashRoute;
  }

  function navigate(route, options = {}) {
    const { updateHistory = true, preserveScroll = false } = options;
    const destination = validRoutes.has(route) ? route : "home";

    pages.forEach((page) => {
      const isActive = page.dataset.page === destination;
      page.hidden = !isActive;
      page.classList.toggle("is-active", isActive);
      page.setAttribute("aria-hidden", String(!isActive));
    });

    navLinks.forEach((link) => {
      const isCurrent = link.dataset.route === destination;
      link.classList.toggle("is-active", isCurrent);
      if (isCurrent) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    });

    state.route = destination;
    closeMobileMenu();
    closeSearch();

    if (siteFooter) {
      siteFooter.hidden = destination === "checkout";
    }

    if (updateHistory) {
      const nextHash = `#${destination}`;
      if (window.location.hash !== nextHash)
        history.pushState({ route: destination }, "", nextHash);
    }

    if (!preserveScroll) window.scrollTo({ top: 0, behavior: "smooth" });

    if (destination === "checkout") startCheckoutTimer();
    else stopCheckoutTimer();
    if (destination === "payments") loadPaymentCenter();

    const activePage = pages.find((page) => page.dataset.page === destination);
    const title = activePage?.querySelector("h1")?.textContent?.trim();
    document.title = title
      ? `${title} | Live Events`
      : "Live Events | Tickets & Membership";
  }

  routeControls.forEach((control) => {
    control.addEventListener("click", (event) => {
      const route = control.dataset.route;
      if (!route || !validRoutes.has(route)) return;
      event.preventDefault();
      navigate(route);
    });
  });

  window.addEventListener("popstate", () =>
    navigate(routeFromHash(), { updateHistory: false }),
  );
  window.addEventListener("hashchange", () => {
    const route = routeFromHash();
    if (route !== state.route) navigate(route, { updateHistory: false });
  });

  function closeMobileMenu() {
    if (!mobileMenu || !menuButton) return;
    mobileMenu.hidden = true;
    menuButton.setAttribute("aria-expanded", "false");
    document.body.classList.remove("menu-open");
  }

  function toggleMobileMenu() {
    if (!mobileMenu || !menuButton) return;
    const isOpening = mobileMenu.hidden;
    mobileMenu.hidden = !isOpening;
    menuButton.setAttribute("aria-expanded", String(isOpening));
    document.body.classList.toggle("menu-open", isOpening);
  }

  function openSearch() {
    if (!searchDialog) return;
    searchDialog.hidden = false;
    document.body.classList.add("dialog-open");
    window.setTimeout(
      () => searchDialog.querySelector('input[type="search"]')?.focus(),
      50,
    );
  }

  function closeSearch() {
    if (!searchDialog) return;
    searchDialog.hidden = true;
    document.body.classList.remove("dialog-open");
  }

  document
    .querySelectorAll('[data-action="toggle-menu"]')
    .forEach((button) => button.addEventListener("click", toggleMobileMenu));
  document
    .querySelectorAll('[data-action="open-search"]')
    .forEach((button) => button.addEventListener("click", openSearch));
  document
    .querySelectorAll('[data-action="close-search"]')
    .forEach((button) => button.addEventListener("click", closeSearch));

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    closeSearch();
    closeMobileMenu();
  });

  function showToast(message, type = "info") {
    if (!toastRegion) return;
    const toast = document.createElement("div");
    toast.className = `toast toast-${type}`;
    toast.setAttribute("role", type === "error" ? "alert" : "status");
    toast.textContent = message;
    toastRegion.appendChild(toast);
    window.setTimeout(() => {
      toast.style.opacity = "0";
      toast.style.transform = "translateY(8px)";
      window.setTimeout(() => toast.remove(), 220);
    }, 3600);
  }

  function formatMoney(amount, currency = state.currency) {
    try {
      return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency,
        minimumFractionDigits: 2,
      }).format(amount);
    } catch {
      return `${currencySymbols[currency] || "$"}${Number(amount).toFixed(2)}`;
    }
  }

  function updateTicketSummary() {
    const total = state.ticketPrice * state.ticketQuantity;
    const summarySection = document.getElementById("summary-section");
    const summaryQuantity = document.getElementById("summary-quantity");
    const summarySubtotal = document.getElementById("summary-subtotal");
    const summaryTotal = document.getElementById("summary-total");
    const checkoutPayButton = document.querySelector(
      '#checkout-form button[type="submit"]',
    );

    if (summarySection)
      summarySection.textContent = state.ticketSection.replace("Section ", "");
    if (summaryQuantity)
      summaryQuantity.textContent = `${state.ticketQuantity} ${state.ticketQuantity === 1 ? "ticket" : "tickets"}`;
    if (summarySubtotal) summarySubtotal.textContent = formatMoney(total);
    if (summaryTotal) summaryTotal.textContent = formatMoney(total);
    if (checkoutPayButton)
      checkoutPayButton.textContent = `Pay ${formatMoney(total)}`;

    document
      .querySelectorAll(".checkout-summary .summary-lines div:first-child dd")
      .forEach((element) => {
        element.textContent = `${state.ticketQuantity} × ${formatMoney(state.ticketPrice)}`;
      });
    document
      .querySelectorAll(".checkout-summary .summary-total dd")
      .forEach((element) => {
        element.textContent = `${state.currency} ${formatMoney(total)}`;
      });
    document.querySelectorAll(".selected-seat strong").forEach((element) => {
      element.textContent = state.ticketSection;
    });
    document.querySelectorAll(".selected-seat span").forEach((element) => {
      element.textContent = `${state.ticketQuantity} ${state.ticketQuantity === 1 ? "ticket" : "tickets"} requested`;
    });
  }

  document
    .querySelectorAll('input[name="ticket-quantity"]')
    .forEach((input) => {
      input.addEventListener("change", () => {
        state.ticketQuantity = Number(input.value) || 1;
        updateTicketSummary();
      });
    });

  document.querySelectorAll('input[name="ticket-option"]').forEach((input) => {
    input.addEventListener("change", () => {
      const option = input.closest(".ticket-option");
      document
        .querySelectorAll(".ticket-option")
        .forEach((card) => card.classList.remove("is-selected"));
      option?.classList.add("is-selected");
      state.ticketPrice = Number(input.dataset.price) || 0;
      state.ticketSection =
        option
          ?.querySelector(".ticket-option-heading strong")
          ?.textContent?.trim() || "Selected seats";
      updateTicketSummary();
    });
  });

  function changePaymentMethod(method) {
    state.paymentMethod = method;
    document.querySelectorAll(".payment-choice").forEach((choice) => {
      const input = choice.querySelector('input[name="payment-method"]');
      choice.classList.toggle("is-selected", input?.value === method);
    });
    document.querySelectorAll("[data-payment-panel]").forEach((panel) => {
      panel.hidden = panel.dataset.paymentPanel !== method;
    });
  }
  async function loadPublicConfig() {
    try {
      const config = await api("/config");
      let selected = null;
      document
        .querySelectorAll('input[name="payment-method"]')
        .forEach((input) => {
          const key = input.value.replace("-", "_");
          input.disabled = !config.payments[key];
          input
            .closest(".payment-choice")
            ?.setAttribute("aria-disabled", String(input.disabled));
          if (!input.disabled && !selected) selected = input;
        });
      const current = document.querySelector(
        'input[name="payment-method"]:checked',
      );
      if (!current || current.disabled) {
        selected.checked = true;
        changePaymentMethod(selected.value);
      }
      document
        .querySelectorAll('input[name="ticket-quantity"]')
        .forEach((input) => {
          input.disabled = Number(input.value) > config.maxOrderQuantity;
        });
    } catch (error) {
      showToast(error.message, "error");
    }
  }

  document.querySelectorAll('input[name="payment-method"]').forEach((input) => {
    input.addEventListener("change", () => changePaymentMethod(input.value));
  });

  function startCheckoutTimer() {
    stopCheckoutTimer();
    const timerElement = document.getElementById("checkout-timer");
    if (!timerElement) return;

    const renderTimer = () => {
      const minutes = Math.floor(checkoutSeconds / 60);
      const seconds = checkoutSeconds % 60;
      timerElement.textContent = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
      if (checkoutSeconds <= 0) {
        stopCheckoutTimer();
        showToast(
          "Your ticket hold has expired. Please select tickets again.",
          "error",
        );
        checkoutSeconds = 9 * 60 + 48;
        navigate("event-details");
        return;
      }
      checkoutSeconds -= 1;
    };

    renderTimer();
    checkoutTimerId = window.setInterval(renderTimer, 1000);
  }

  function stopCheckoutTimer() {
    if (!checkoutTimerId) return;
    window.clearInterval(checkoutTimerId);
    checkoutTimerId = null;
  }

  const checkoutForm = document.getElementById("checkout-form");
  checkoutForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!checkoutForm.reportValidity()) return;

    const submitButton = checkoutForm.querySelector('button[type="submit"]');
    const originalLabel = submitButton.textContent;
    submitButton.disabled = true;
    submitButton.textContent = "Submitting...";
    try {
      if (!state.eventId || !state.sectionId)
        throw new Error(
          "Select an available event option before submitting an order.",
        );
      const formData = new FormData(checkoutForm);
      state.checkoutKey ||= crypto.randomUUID();
      const data = await api("/orders", {
        method: "POST",
        headers: { "Idempotency-Key": state.checkoutKey },
        body: JSON.stringify({
          eventId: state.eventId,
          sectionId: state.sectionId,
          quantity: state.ticketQuantity,
          paymentMethod: state.paymentMethod.replace("-", "_"),
          contactName:
            `${formData.get("first-name")} ${formData.get("last-name")}`.trim(),
          contactEmail: String(formData.get("email") || ""),
          contactPhone: String(formData.get("phone") || ""),
          contactCountry: formData.get("phone-country") === "OTHER"
            ? String(formData.get("phone-country-name") || "").trim()
            : String(formData.get("phone-country") || ""),
        }),
      });
      state.orderNumber = data.reference;
      const orderNumber = document.getElementById("order-number");
      if (orderNumber) orderNumber.textContent = state.orderNumber;
      checkoutSeconds = 9 * 60 + 48;
      navigate("success");
      showToast(data.message, "success");
    } catch (error) {
      showToast(error.message, "error");
    } finally {
      submitButton.disabled = false;
      submitButton.textContent = originalLabel;
    }
  });

  const authTabs = [...document.querySelectorAll("[data-auth-tab]")];
  function switchAuthTab(tabName) {
    authTabs.forEach((tab) => {
      const isActive = tab.dataset.authTab === tabName;
      tab.setAttribute("aria-selected", String(isActive));
      tab.tabIndex = isActive ? 0 : -1;
    });
    const loginPanel = document.getElementById("login-panel");
    const registerPanel = document.getElementById("register-panel");
    if (loginPanel) loginPanel.hidden = tabName !== "login";
    if (registerPanel) registerPanel.hidden = tabName !== "register";
  }

  authTabs.forEach((tab) => {
    tab.addEventListener("click", () => switchAuthTab(tab.dataset.authTab));
    tab.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
      event.preventDefault();
      const nextTab = tab.dataset.authTab === "login" ? "register" : "login";
      switchAuthTab(nextTab);
      document.querySelector(`[data-auth-tab="${nextTab}"]`)?.focus();
    });
  });

  document.querySelector('[data-action="open-login"]')?.addEventListener("click", () => {
    switchAuthTab("login");
    navigate("account");
  });
  document.querySelector('[data-action="open-register"]')?.addEventListener("click", () => {
    switchAuthTab("register");
    navigate("account");
  });

  ["login-panel", "register-panel"].forEach((formId) => {
    const form = document.getElementById(formId);
    form?.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!form.reportValidity()) return;
      const data = new FormData(form);
      try {
        if (formId === "login-panel") {
          const result = await api("/auth/login", {
            method: "POST",
            body: JSON.stringify({
              email: data.get("login-email"),
              password: data.get("login-password"),
            }),
          });
          csrfToken = result.csrfToken;
          showToast("Signed in successfully.", "success");
          await loadAccountOrders();
        } else {
          const result = await api("/auth/register", {
            method: "POST",
            body: JSON.stringify({
              fullName: data.get("register-name"),
              email: data.get("register-email"),
              password: data.get("register-password"),
            }),
          });
          showToast(
            result.emailVerificationRequired
              ? "Account created. Check your email to verify it."
              : "Account created.",
            "success",
          );
        }
      } catch (error) {
        showToast(error.message, "error");
      }
    });
  });

  document
    .querySelector('[data-action="forgot-password"]')
    ?.addEventListener("click", async () => {
      const email = document.querySelector('[name="login-email"]')?.value;
      if (!email) return showToast("Enter your email address first.", "error");
      try {
        await api("/auth/forgot-password", {
          method: "POST",
          body: JSON.stringify({ email }),
        });
        showToast(
          "If the account exists, password-reset instructions will be sent.",
        );
      } catch (error) {
        showToast(error.message, "error");
      }
    });

  document
    .querySelector('[data-action="customer-logout"]')
    ?.addEventListener("click", async () => {
      try {
        await api("/auth/logout", { method: "POST", body: "{}" });
      } finally {
        csrfToken = "";
        document.getElementById("account-status").hidden = true;
        setCustomerSession();
        setMembershipStatus();
        showToast("Signed out.");
      }
    });

  const membershipForm = document.getElementById("membership-form");
  membershipForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!membershipForm.reportValidity()) return;
    const f = new FormData(membershipForm);
    const countries = {
      "United States": "US",
      "United Kingdom": "GB",
      Canada: "CA",
      Australia: "AU",
      Nigeria: "NG",
      Other: "ZZ",
    };
    try {
      await api("/membership-applications", {
        method: "POST",
        body: JSON.stringify({
          fullName:
            `${f.get("member-first-name")} ${f.get("member-last-name")}`.trim(),
          email: f.get("member-email"),
          country: f.get("member-country") === "OTHER"
            ? String(f.get("member-country-name") || "").trim()
            : countries[f.get("member-country")] || "",
          reason: f.get("membership-reason"),
          interest: f.get("membership-interest"),
        }),
      });
      membershipForm.reset();
      showToast("Your membership application has been submitted.", "success");
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (error) {
      showToast(error.message, "error");
    }
  });

  document
    .querySelector('[data-action="scroll-to-application"]')
    ?.addEventListener("click", () => {
      document
        .getElementById("membership-application")
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    });

  const serviceEnquiry = document.getElementById("service-enquiry");
  const serviceTypeInput = document.getElementById("service-type");
  document
    .querySelectorAll('[data-action="open-service-form"]')
    .forEach((button) => {
      button.addEventListener("click", () => {
        if (serviceTypeInput)
          serviceTypeInput.value = button.dataset.service || "General enquiry";
        if (serviceEnquiry) serviceEnquiry.hidden = false;
        serviceEnquiry?.scrollIntoView({ behavior: "smooth", block: "start" });
        document
          .querySelector('input[name="service-name"]')
          ?.focus({ preventScroll: true });
      });
    });

  document
    .querySelector('[data-action="close-service-form"]')
    ?.addEventListener("click", () => {
      if (serviceEnquiry) serviceEnquiry.hidden = true;
    });

  const serviceForm = document.getElementById("service-form");
  serviceForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!serviceForm.reportValidity()) return;
    const f = new FormData(serviceForm);
    const categories = {
      "Private event enquiry": "private_event",
      "Meet-and-greet request": "meet_and_greet",
    };
    try {
      await api("/service-requests", {
        method: "POST",
        body: JSON.stringify({
          category: categories[f.get("service-type")] || "general",
          fullName: f.get("service-name"),
          email: f.get("service-email"),
          phone: f.get("service-phone") || undefined,
          message: f.get("service-message"),
        }),
      });
      serviceForm.reset();
      if (serviceEnquiry) serviceEnquiry.hidden = true;
      showToast("Your enquiry has been received.", "success");
    } catch (error) {
      showToast(error.message, "error");
    }
  });

  const supportForm = document.getElementById("support-form");
  supportForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!supportForm.reportValidity()) return;
    const f = new FormData(supportForm);
    try {
      await api("/support-requests", {
        method: "POST",
        body: JSON.stringify({
          name: f.get("support-name"),
          email: f.get("support-email"),
          orderReference: f.get("order-number") || undefined,
          message: f.get("support-message"),
        }),
      });
      supportForm.reset();
      showToast("Your support request has been received.", "success");
    } catch (error) {
      showToast(error.message, "error");
    }
  });

  const newsletterForm = document.getElementById("newsletter-form");
  newsletterForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!newsletterForm.reportValidity()) return;
    const emailInput = newsletterForm.querySelector('input[name="newsletter-email"]');
    const submitButton = newsletterForm.querySelector('button[type="submit"]');
    const email = String(emailInput?.value || "").trim();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      showToast("Enter a valid email address.", "error");
      emailInput?.focus();
      return;
    }
    if (submitButton) {
      submitButton.disabled = true;
      submitButton.textContent = "Joining…";
    }
    try {
      const data = await api("/newsletter/subscribe", {
        method: "POST",
        body: JSON.stringify({ email }),
      });
      newsletterForm.reset();
      showToast(data.message || "You are subscribed to updates.", "success");
    } catch (error) {
      showToast(error.message, "error");
    } finally {
      if (submitButton) {
        submitButton.disabled = false;
        submitButton.textContent = "Join";
      }
    }
  });

  document
    .querySelectorAll('[data-action="notify-event"]')
    .forEach((button) => {
      button.addEventListener("click", () =>
        showToast("Event notifications will be available after account setup."),
      );
    });

  const eventFilterForm = document.getElementById("event-filter-form");
  eventFilterForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    const data = new FormData(eventFilterForm);
    const query = String(data.get("event-search") || "")
      .trim()
      .toLowerCase();
    const city = String(data.get("city") || "");
    const date = String(data.get("date") || "");
    if (query || city || date) {
      const now = new Date();
      let from = null,
        to = null;
      if (date === "this-week") {
        from = now;
        to = new Date(now.getTime() + 7 * 86400000);
      }
      if (date === "this-month") {
        from = now;
        to = new Date(now.getFullYear(), now.getMonth() + 1, 1);
      }
      if (date === "next-month") {
        from = new Date(now.getFullYear(), now.getMonth() + 1, 1);
        to = new Date(now.getFullYear(), now.getMonth() + 2, 1);
      }
      loadPublicEvents(query, {
        city,
        from: from?.toISOString(),
        to: to?.toISOString(),
      });
      return;
    }
    const rows = [...document.querySelectorAll("#event-list .event-row")];
    let visibleCount = 0;

    rows.forEach((row) => {
      const matchesText =
        !query || row.textContent.toLowerCase().includes(query);
      const matchesCity = !city || row.dataset.city === city;
      const matchesDate = !date || row.dataset.date === date;
      const isVisible = matchesText && matchesCity && matchesDate;
      row.hidden = !isVisible;
      if (isVisible) visibleCount += 1;
    });

    const count = document.getElementById("event-count");
    if (count) count.textContent = String(visibleCount);
    if (visibleCount === 0)
      showToast("No events match those filters. Try a different search.");
  });

  const globalSearchForm = document.getElementById("global-search-form");
  globalSearchForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    const query = String(
      new FormData(globalSearchForm).get("global-search") || "",
    ).trim();
    closeSearch();
    navigate("events");
    const eventSearch = document.querySelector('input[name="event-search"]');
    if (eventSearch) eventSearch.value = query;
    eventFilterForm?.requestSubmit();
  });

  const currentYear = document.getElementById("current-year");
  if (currentYear) currentYear.textContent = String(new Date().getFullYear());

  changePaymentMethod(state.paymentMethod);
  updateTicketSummary();
  switchAuthTab("login");
  navigate(routeFromHash(), { updateHistory: false });
  loadPublicEvents();
  loadPublicConfig();
  (async () => {
    const url = new URL(window.location.href);
    const params = url.searchParams;
    const fragmentParams = new URLSearchParams(url.hash.replace(/^#/, ""));
    const tokenHash = params.get("token_hash"),
      accessToken = fragmentParams.get("access_token"),
      refreshToken = fragmentParams.get("refresh_token"),
      type = params.get("type") || fragmentParams.get("type");
    try {
      if (tokenHash && type === "email") {
        const result = await api("/auth/verify-email", {
          method: "POST",
          body: JSON.stringify({ tokenHash }),
        });
        csrfToken = result.csrfToken;
        showToast("Email verified successfully.", "success");
        history.replaceState({}, "", `${window.location.pathname}#account`);
        navigate("account");
        await loadAccountOrders();
        return;
      }
      if (tokenHash && type === "recovery") {
        const result = await api("/auth/password-reset-session", {
          method: "POST",
          body: JSON.stringify({ tokenHash }),
        });
        csrfToken = result.csrfToken;
        const values = await openAccountDialog({
          title: "Set a new password",
          description: "Choose a new password with at least 8 characters.",
          fields: [
            { name: "password", label: "New password", type: "password", required: true },
            { name: "confirmPassword", label: "Confirm new password", type: "password", required: true },
          ],
          submitLabel: "Update password",
        });
        if (values) {
          const password = String(values.get("password") || "").trim();
          const confirmPassword = String(values.get("confirmPassword") || "").trim();
          if (password !== confirmPassword) throw new Error("Password and Confirm Password must match.");
          await api("/auth/reset-password", {
            method: "POST",
            body: JSON.stringify({ password, confirmPassword }),
          });
          csrfToken = "";
          document.getElementById("account-status").hidden = true;
          showToast("Password updated.", "success");
        }
        history.replaceState({}, "", `${window.location.pathname}#account`);
        navigate("account");
        return;
      }
      if (accessToken && refreshToken && type === "recovery") {
        const result = await api("/auth/password-reset-session", {
          method: "POST",
          body: JSON.stringify({ accessToken, refreshToken }),
        });
        csrfToken = result.csrfToken;
        const values = await openAccountDialog({
          title: "Set a new password",
          description: "Choose a new password with at least 8 characters.",
          fields: [
            { name: "password", label: "New password", type: "password", required: true },
            { name: "confirmPassword", label: "Confirm new password", type: "password", required: true },
          ],
          submitLabel: "Update password",
        });
        if (values) {
          const password = String(values.get("password") || "").trim();
          const confirmPassword = String(values.get("confirmPassword") || "").trim();
          if (password !== confirmPassword) throw new Error("Password and Confirm Password must match.");
          await api("/auth/reset-password", {
            method: "POST",
            body: JSON.stringify({ password, confirmPassword }),
          });
          csrfToken = "";
          document.getElementById("account-status").hidden = true;
          showToast("Password updated.", "success");
        }
        history.replaceState({}, "", `${window.location.pathname}#account`);
        navigate("account");
        return;
      }
      const refreshed = await api("/auth/refresh", {
        method: "POST",
        body: "{}",
      });
      csrfToken = refreshed.csrfToken;
      const profile = await api("/auth/me");
      setCustomerSession(profile);
      const applications = await api("/account/membership-applications");
      setMembershipStatus(applications);
      if (routeFromHash() === "account") await loadAccountOrders();
      if (routeFromHash() === "payments") await loadPaymentCenter();
    } catch (error) {
      if (tokenHash || (accessToken && refreshToken)) showToast(error.message, "error");
    }
  })();
});
