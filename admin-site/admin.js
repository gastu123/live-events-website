"use strict";
document.addEventListener("DOMContentLoaded", () => {
  const configuredApiBase = document.querySelector('meta[name="admin-api-base-url"]')?.content.trim();
  const apiBase = configuredApiBase && configuredApiBase !== "__ADMIN_API_BASE_URL__" ? configuredApiBase.replace(/\/$/, "") : "";
  const login = document.getElementById("admin-login"),
    app = document.getElementById("admin-app"),
    form = document.getElementById("admin-login-form"),
    sidebar = document.getElementById("admin-sidebar"),
    backdrop = document.querySelector(".sidebar-backdrop"),
    title = document.getElementById("current-page-title"),
    toastRegion = document.getElementById("admin-toast-region"),
    confirmDialog = document.getElementById("confirm-dialog"),
    confirmTitle = document.getElementById("confirm-title"),
    confirmMessage = document.getElementById("confirm-message"),
    confirmButton = document.getElementById("confirm-action-button");
  const pages = new Map(
    [...document.querySelectorAll("[data-admin-page]")].filter((page) => !["members", "applications"].includes(page.dataset.adminPage)).map((page) => [
      page.dataset.adminPage,
      page,
    ]),
  );
  document.querySelectorAll('[data-admin-page="members"],[data-admin-page="applications"]').forEach((node) => node.remove());
  const names = {
    overview: "Overview",
    orders: "Orders",
    tickets: "Ticket Inventory",
    events: "Events",
    payments: "Payments",
    services: "Service Requests",
    team: "Admin Team",
    audit: "Audit Log",
    settings: "Settings",
  };
  let csrfToken = "",
    pendingConfirm = null,
    deferredInstallPrompt = null,
    recoveryResetToken = "";
  const authStorageKey = "live-admin-session";
  let authTokens = loadAuthTokens();
  function loadAuthTokens() {
    try {
      return JSON.parse(sessionStorage.getItem(authStorageKey) || "null");
    } catch {
      return null;
    }
  }
  function saveAuthTokens(result) {
    if (!result?.accessToken || !result?.refreshToken) return;
    authTokens = {
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
    };
    try {
      sessionStorage.setItem(authStorageKey, JSON.stringify(authTokens));
    } catch {
      authTokens = null;
    }
  }
  function clearAuthTokens() {
    authTokens = null;
    try {
      sessionStorage.removeItem(authStorageKey);
    } catch {}
  }
  const el = (tag, attrs = {}, ...children) => {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (value == null) continue;
      if (key === "class") node.className = value;
      else if (key === "text") node.textContent = value;
      else if (key.startsWith("data-")) node.setAttribute(key, value);
      else if (key in node) node[key] = value;
      else node.setAttribute(key, value);
    }
    for (const child of children.flat()) {
      if (child != null)
        node.append(
          child.nodeType ? child : document.createTextNode(String(child)),
        );
    }
    return node;
  };
  const money = (minor, currency) =>
    new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: currency || "USD",
    }).format(Number(minor || 0) / 100);
  const date = (value) => (value ? new Date(value).toLocaleString() : "—");
  const paymentMethodLabel = (value) => ({ gift_card: "Gift Card" }[value] || String(value || "payment").replaceAll("_", " "));
  function toast(message, type = "info") {
    if (!toastRegion) return;
    const item = el("div", { class: `toast ${type}`, text: message });
    item.setAttribute("role", type === "error" ? "alert" : "status");
    toastRegion.append(item);
    setTimeout(() => item.remove(), 4200);
  }
  async function api(path, options = {}) {
    const headers = {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    };
    if (csrfToken) headers["X-CSRF-Token"] = csrfToken;
    if (authTokens?.accessToken && !headers.Authorization)
      headers.Authorization = `Bearer ${authTokens.accessToken}`;
    const response = await fetch(`${apiBase}/api/v1${path}`, {
      credentials: "include",
      ...options,
      headers,
    });
    const payload = await response.json().catch(() => ({}));
    if (response.status === 401) {
      showAuthenticated(false);
    }
    if (!response.ok) {
      const error = new Error(payload.error?.message || "Request failed.");
      error.code = payload.error?.code;
      throw error;
    }
    return payload.data;
  }
  function showAuthenticated(value) {
    login.hidden = value;
    app.hidden = !value;
    document.body.classList.toggle("authenticated", value);
  }
  function heading(kicker, name, description, ...actions) {
    return el(
      "div",
      { class: "page-heading" },
      el(
        "div",
        {},
        el("p", { class: "eyebrow", text: kicker }),
        el("h2", { text: name }),
        el("p", { text: description }),
      ),
      actions.length ? el("div", {}, actions) : null,
    );
  }
  function panel(...children) {
    return el("section", { class: "panel" }, ...children);
  }
  function button(label, action, kind = "secondary-button", data = {}) {
    const node = el("button", {
      type: "button",
      class: kind,
      text: label,
      "data-action": action,
    });
    for (const [key, value] of Object.entries(data)) node.dataset[key] = value;
    return node;
  }
  function status(value) {
    const good = [
      "successful",
      "payment_successful",
      "approved",
      "active",
      "published",
      "resolved",
    ].includes(value);
    const danger = ["failed", "declined", "disabled", "cancelled"].includes(
      value,
    );
    return el("span", {
      class: `status ${good ? "success" : danger ? "danger" : "pending"}`,
      text: String(value || "unknown").replaceAll("_", " "),
    });
  }
  function table(headers, rows, emptyMessage = "No records yet.") {
    const body = el("tbody");
    if (!rows.length)
      body.append(
        el("tr", {}, el("td", { colspan: headers.length, text: emptyMessage })),
      );
    for (const values of rows) {
      const row = el("tr");
      for (const value of values)
        row.append(
          el("td", {}, value?.nodeType ? value : String(value ?? "—")),
        );
      body.append(row);
    }
    return el(
      "div",
      { class: "table-wrap" },
      el(
        "table",
        {},
        el(
          "thead",
          {},
          el(
            "tr",
            {},
            headers.map((text) => el("th", { text })),
          ),
        ),
        body,
      ),
    );
  }
  function renderState(page, message, isError = false) {
    page.replaceChildren(
      heading("LIVE ADMIN", names[page.dataset.adminPage] || "Admin", message),
      panel(
        el("p", {
          class: isError ? "status danger" : "panel-description",
          text: message,
        }),
      ),
    );
  }
  function promptFields(fields, title = "Complete details", submitLabel = "Save") {
    return new Promise((resolve) => {
      const dialog = el("div", { class: "confirm-dialog", role: "dialog", "aria-modal": "true" });
      const close = (value = null) => {
        dialog.remove();
        resolve(value);
      };
      const form = el("form", { class: "confirm-card recovery-card drawer-form" },
        el("h2", { text: title }),
        el("p", { text: "Complete the fields below. Nothing is saved until you confirm." }),
      );
      fields.forEach(([key, label, initial = "", type, options = []]) => {
        const multiline = type === "textarea" || /notes|instructions|description|reply/i.test(key);
        const input = el(type === "select" ? "select" : multiline ? "textarea" : "input", {
          name: key,
          value: initial,
          required: !/optional/i.test(label) && /reason|name|title|venue|city|country|eventDate|eventTime|price|quantity|paymentMethod|accountName|paymentIdentifier|paymentReference|amount|currency|expiresAt|email|phone|status/i.test(key),
        });
        if (type === "select")
          options.forEach(([value, text]) => input.append(el("option", { value, text, selected: value === initial })));
        else if (!multiline) input.type = type || (/email/i.test(key) ? "email" : /password/i.test(key) ? "password" : "text");
        if (/password/i.test(key)) {
          input.minLength = 8;
          input.pattern = "(?=.*[A-Za-z])(?=.*[0-9]).{8,}";
          input.title = "Use at least 8 characters, including a letter and a number.";
        }
        form.append(el("label", {}, label, input));
      });
      form.append(el("div", { class: "recovery-actions" },
        el("button", { class: "secondary-button", type: "button", text: "Cancel" }),
        el("button", { class: "primary-button", type: "submit", text: submitLabel }),
      ));
      form.querySelector('[type="button"]').addEventListener("click", () => close());
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        if (!form.reportValidity()) return;
        close(Object.fromEntries([...new FormData(form)].map(([key, value]) => [key, String(value).trim()])));
      });
      dialog.append(el("button", { class: "dialog-backdrop", type: "button", "aria-label": "Cancel" }), form);
      dialog.querySelector(".dialog-backdrop").addEventListener("click", () => close());
      document.body.append(dialog);
      form.querySelector("input,textarea")?.focus();
    });
  }
  function eventDateTimeFields(value) {
    const initial = value ? new Date(value) : new Date(Date.now() + 86400000);
    const pad = (part) => String(part).padStart(2, "0");
    return [
      ["eventDate", "Event date", `${initial.getFullYear()}-${pad(initial.getMonth() + 1)}-${pad(initial.getDate())}`, "date"],
      ["eventTime", "Event time", `${pad(initial.getHours())}:${pad(initial.getMinutes())}`, "time"],
    ];
  }
  function eventStartsAt(values) {
    return new Date(`${values.eventDate}T${values.eventTime}`).toISOString();
  }
  function promptPaymentDetails(control) {
    return new Promise((resolve) => {
      const giftCard = control.dataset.method === "gift_card";
      const dialog = el("div", { class: "confirm-dialog", role: "dialog", "aria-modal": "true" });
      const form = el("form", { class: "confirm-card recovery-card drawer-form" },
        el("h2", { text: giftCard ? "Assign payment method" : "Assign payment details" }),
        el("p", { text: giftCard ? "Gift Card requires no payment details. Set the shared expiry and assign it." : "Enter only the receiving details needed for this payment method." }),
        el("p", { class: "muted", text: `${control.dataset.method} • ${(Number(control.dataset.amount) / 100).toFixed(2)} ${control.dataset.currency}` }),
      );
      const method = el("select", { name: "paymentMethod", required: true });
      [["paypal", "PayPal"], ["cash_app", "Cash App"], ["chime", "Chime"], ["bank_transfer", "Bank Transfer"], ["gift_card", "Gift Card"]].forEach(([value, text]) =>
        method.append(el("option", { value, text, selected: value === control.dataset.method })),
      );
      form.append(el("label", {}, "Payment method", method));
      const fields = el("div", { class: "payment-method-fields" });
      const addField = (name, label, required = true, type = "text") => {
        const input = el(type === "textarea" ? "textarea" : "input", { name, type: type === "textarea" ? undefined : type, required });
        fields.append(el("label", {}, label, input));
      };
      const renderFields = () => {
        fields.replaceChildren();
        if (method.value === "bank_transfer") {
          addField("bankName", "Bank name");
          addField("accountName", "Account name");
          addField("accountNumber", "Account number");
        } else if (method.value === "paypal") addField("paymentIdentifier", "PayPal email or account identifier");
        else if (method.value === "cash_app") addField("paymentIdentifier", "Cash App $Cashtag");
        else addField("paymentIdentifier", "Chime receiving identifier");
        if (method.value !== "gift_card") addField("instructions", "Optional payment instructions", false, "textarea");
        const expiry = el("select", { name: "expiresInHours", required: true });
        [["1", "1 hour"], ["6", "6 hours"], ["24", "24 hours"], ["72", "3 days"], ["168", "7 days"]].forEach(([value, text], index) =>
          expiry.append(el("option", { value, text, selected: index === 2 })),
        );
        fields.append(el("label", {}, "Payment details expire", expiry));
      };
      method.addEventListener("change", renderFields);
      renderFields();
      form.append(fields, el("div", { class: "recovery-actions" },
        el("button", { class: "secondary-button", type: "button", text: "Cancel" }),
        el("button", { class: "primary-button", type: "submit", text: giftCard ? "Assign Gift Card" : "Assign payment details" }),
      ));
      const close = (value = null) => { dialog.remove(); resolve(value); };
      form.querySelector('[type="button"]').addEventListener("click", () => close());
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        if (!form.reportValidity()) return;
        close(Object.fromEntries([...new FormData(form)].map(([key, value]) => [key, String(value).trim()])));
      });
      dialog.append(el("button", { class: "dialog-backdrop", type: "button", "aria-label": "Cancel" }), form);
      dialog.querySelector(".dialog-backdrop").addEventListener("click", () => close());
      document.body.append(dialog);
      method.focus();
    });
  }
  pages.forEach((page) =>
    renderState(page, "Sign in to load live administration data."),
  );
  async function showDevelopmentDemoLogin() {
    try {
      const config = await api("/config");
      const demo = config.developmentDemo;
      if (!demo?.enabled) return;
      const notice = document.getElementById("development-demo-login");
      notice.replaceChildren(
        el("strong", { text: "LOCAL DEVELOPMENT DEMO" }),
        el("span", {
          text: `Email: ${demo.adminEmail} · Password: ${demo.adminPassword}`,
        }),
        el("small", { text: demo.notice }),
      );
      notice.hidden = false;
      form.querySelector('[name="admin-email"]').value = demo.adminEmail;
      form.querySelector('[name="admin-password"]').value = demo.adminPassword;
    } catch {
      // The normal production login remains unchanged if config is unavailable.
    }
  }
  showDevelopmentDemoLogin();
  function confirm(titleText, message, callback, label = "Confirm") {
    pendingConfirm = callback;
    confirmTitle.textContent = titleText;
    confirmMessage.textContent = message;
    confirmButton.textContent = label;
    confirmDialog.hidden = false;
    confirmButton.focus();
  }
  document.querySelectorAll('[data-action="cancel-confirm"]').forEach((b) =>
    b.addEventListener("click", () => {
      confirmDialog.hidden = true;
      pendingConfirm = null;
    }),
  );
  confirmButton?.addEventListener("click", async () => {
    const callback = pendingConfirm;
    confirmDialog.hidden = true;
    pendingConfirm = null;
    if (callback) await callback();
  });
  function updateNavigationCounts(data) {
    [
      ["nav-pending-orders", data.pending_orders],
      ["nav-pending-payments", data.pending_payments],
    ].forEach(([id, count]) => {
      const badge = document.getElementById(id);
      if (!badge) return;
      badge.textContent = String(count || 0);
      badge.hidden = Number(count || 0) === 0;
    });
  }
  async function refreshNavigationCounts() {
    updateNavigationCounts(await api("/admin/overview"));
  }
  const loaders = {
    async overview(page) {
      const data = await api("/admin/overview");
      updateNavigationCounts(data);
      const metrics = [
        ["Pending orders", data.pending_orders],
        ["Successful payments", data.successful_payments],
        ["Open services", data.open_services],
      ];
      page.replaceChildren(
        heading(
          "OPERATIONS",
          names.overview,
          "Live totals from the administration API",
          button("Refresh", "refresh", "secondary-button"),
        ),
        el(
          "div",
          { class: "metric-grid" },
          metrics.map(([label, value]) =>
            el(
              "article",
              { class: "metric-card" },
              el("span", { text: label }),
              el("strong", { text: String(value) }),
            ),
          ),
        ),
      );
    },
    async orders(page) {
      const rows = await api("/admin/orders");
      page.replaceChildren(
        heading(
          "SALES MANAGEMENT",
          names.orders,
          "Pending order requests and verified payment states.",
        ),
        panel(
          table(
            [
              "Reference",
              "Customer",
              "Event",
              "Quantity",
              "Method",
              "Payment",
              "Total",
              "Created",
            ],
            rows.map((row) => [
              row.reference,
              row.contact_name,
              row.event_title,
              row.quantity || "—",
              paymentMethodLabel(row.payment_method),
              status(row.payment_status),
              money(row.total_minor, row.currency),
              date(row.created_at),
            ]),
          ),
        ),
      );
    },
    async tickets(page) {
      const events = await api("/admin/events");
      const sections = (
        await Promise.all(
          events.map(async (event) => {
            try {
              return (await api(`/admin/events/${event.id}/sections`)).map(
                (section) => ({
                  ...section,
                  event_title: event.title,
                  currency: event.currency,
                }),
              );
            } catch {
              return [];
            }
          }),
        )
      ).flat();
      page.replaceChildren(
        heading(
          "ORDER AVAILABILITY",
          names.tickets,
          "Configured sections, prices, active holds and remaining inventory. Fulfilment is not enabled.",
        ),
        panel(
          table(
            [
              "Event",
              "Section",
              "Price",
              "Capacity",
              "Held",
              "Paid",
              "Remaining",
              "Action",
            ],
            sections.map((section) => [
              section.event_title,
              section.name,
              money(section.price_minor, section.currency),
              section.available_quantity,
              section.held_quantity,
              section.sold_quantity,
              section.remaining_quantity,
              button("Edit inventory", "edit-inventory", "text-button", {
                id: section.id,
                price: section.price_minor,
                quantity: section.available_quantity,
              }),
            ]),
          ),
        ),
      );
    },
    async events(page) {
      const events = await api("/admin/events");
      const grid = el("div", { class: "admin-event-grid" });
      if (!events.length)
        grid.append(panel(el("p", { text: "No events yet." })));
      for (const event of events) {
        grid.append(
          el(
            "article",
            { class: "admin-event-card" },
            el(
              "div",
              { class: "admin-event-body" },
              status(event.status),
              el("h3", { text: event.title }),
              el("p", {
                text: `${event.venue} • ${event.city} • ${date(event.starts_at)}`,
              }),
              el(
                "div",
                { class: "card-actions" },
                button("Edit", "edit-event", "secondary-button", {
                  id: event.id,
                  title: event.title,
                  venue: event.venue,
                  city: event.city,
                  country: event.country,
                  startsAt: event.starts_at,
                  currency: event.currency,
                  description: event.description || "",
                }),
                button(
                  event.status === "published" ? "Unpublish" : "Publish",
                  "event-status",
                  "secondary-button",
                  {
                    id: event.id,
                    status:
                      event.status === "published"
                        ? "unpublished"
                        : "published",
                  },
                ),
                button("Add section", "add-section", "primary-button", {
                  id: event.id,
                }),
                button("Delete", "delete-event", "danger-button", {
                  id: event.id,
                  title: event.title,
                }),
              ),
            ),
          ),
        );
      }
      page.replaceChildren(
        heading(
          "SHOW MANAGEMENT",
          names.events,
          "Create events, publish listings and manage order inventory.",
          button("+ Create event", "create-event", "primary-button"),
        ),
        grid,
      );
    },
    async payments(page) {
      const rows = await api("/admin/payments");
      const needsDetails = rows.filter((row) =>
        ["awaiting_payment_details", "payment_details_expired"].includes(
          row.status,
        ),
      ).length;
      const needsVerification = rows.filter((row) =>
        ["payment_details_ready", "pending_verification"].includes(row.status),
      ).length;
      page.replaceChildren(
        heading(
          "ACTION REQUIRED",
          names.payments,
          `${needsDetails} awaiting details • ${needsVerification} awaiting verification. All transfers happen outside this website and require administrator confirmation.`,
        ),
        panel(
          table(
            [
              "Order",
              "Customer",
              "Method",
              "Amount",
              "Status",
              "Assignment",
              "Created",
              "Action",
            ],
            rows.map((row) => {
              const actions = el("div", { class: "inline-actions" });
              if (["payment_details_ready", "pending_verification"].includes(row.status)) {
                actions.append(
                  button("Evidence", "view-evidence", "text-button", {
                    id: row.id,
                  }),
                  button("Reject", "manual-payment", "danger-button small", {
                    id: row.id,
                    decision: "reject",
                  }),
                  button(
                    "Confirm Payment",
                    "manual-payment",
                    "primary-button small",
                    {
                      id: row.id,
                      decision: "confirm",
                      amount: row.amount_minor,
                      currency: row.currency,
                    },
                  ),
                );
              }
              if (
                [
                  "awaiting_payment_details",
                  "payment_details_expired",
                ].includes(row.status)
              ) {
                actions.append(
                  button(
                      row.status === "payment_details_expired"
                        ? row.method === "gift_card" ? "Reassign Gift Card" : "Replace details"
                        : row.method === "gift_card" ? "Assign Gift Card" : "Enter payment details",
                    "assign-details",
                    "primary-button small",
                    {
                      id: row.id,
                      method: row.method,
                      amount: row.amount_minor,
                      currency: row.currency,
                    },
                  ),
                );
              }
              return [
                row.order_reference,
                `${row.contact_name} (${row.contact_email})`,
                paymentMethodLabel(row.method),
                money(row.amount_minor, row.currency),
                status(row.status),
                row.assignment_status
                  ? `${row.assignment_status}${row.assignment_expires_at ? ` • ${date(row.assignment_expires_at)}` : ""}`
                  : "Not assigned",
                date(row.created_at),
                actions,
              ];
            }),
          ),
        ),
      );
    },
    async services(page) {
      const rows = await api("/admin/service-requests");
      page.replaceChildren(
        heading(
          "SPECIAL REQUESTS",
          names.services,
          "Assign, update, reply to and archive service enquiries.",
        ),
        panel(
          table(
            ["Customer", "Category", "Message", "Status", "Created", "Action"],
            rows.map((row) => [
              row.full_name,
              row.category,
              row.message,
              status(row.status),
              date(row.created_at),
              button("Manage", "service-update", "text-button", { id: row.id }),
            ]),
          ),
        ),
      );
    },
    async team(page) {
      const [admins, roles, permissions, loginHistory] = await Promise.all([
        api("/admin/admins"),
        api("/admin/roles"),
        api("/admin/permissions"),
        api("/admin/login-history"),
      ]);
      const rows = admins.map((admin) => {
        const select = el("select", {
          "data-admin-id": admin.id,
          disabled: admin.is_super_admin,
        });
        for (const role of roles)
          select.append(
            el("option", {
              value: role.id,
              text: role.name,
              selected: role.id === admin.role_id,
            }),
          );
        select.addEventListener("change", async () => {
          try {
            await api(`/admin/admins/${admin.id}/role`, {
              method: "PATCH",
              body: JSON.stringify({ roleId: select.value }),
            });
            toast("Administrator role updated.", "success");
          } catch (error) {
            toast(error.message, "error");
            await load("team");
          }
        });
        const actions = el("div", { class: "recovery-actions" },
          admin.is_super_admin ? null : button(admin.status === "active" ? "Deactivate" : "Activate", "admin-status", "secondary-button small", { id: admin.id, status: admin.status === "active" ? "disabled" : "active" }),
          button("Recovery", "admin-recovery", "secondary-button small", { id: admin.id }),
          admin.is_super_admin ? el("span", { class: "status danger", text: "Super admin" }) : button("Remove", "remove-admin", "danger-button small", { id: admin.id }),
        );
        return [
          admin.full_name,
          admin.role,
          status(admin.status),
          admin.two_factor_required ? "Required" : "Not required",
          date(admin.last_login_at),
          `${admin.recovery_email_masked || "Not set"} / ${admin.recovery_phone_masked || "Not set"}`,
          select,
          actions,
        ];
      });
      page.replaceChildren(
        heading(
          "ACCESS CONTROL",
          names.team,
          "Role-based administrators with protected ownership.",
        ),
        panel(
          el("form", { id: "admin-invite-form", class: "drawer-form" },
            el("h3", { text: "Create Administrator account" }),
            el("p", { class: "muted", text: "New accounts are standard Administrators. The protected Super Administrator role cannot be assigned." }),
            el("input", { name: "fullName", placeholder: "Full name", required: true }),
            el("input", { name: "email", type: "email", placeholder: "Login email", required: true }),
            el("input", { name: "password", type: "password", placeholder: "Password", autocomplete: "new-password", minlength: 8, pattern: "(?=.*[A-Za-z])(?=.*[0-9]).{8,}", title: "Use at least 8 characters, including a letter and a number.", required: true }),
            el("input", { name: "confirmPassword", type: "password", placeholder: "Confirm password", autocomplete: "new-password", minlength: 8, required: true }),
            el("input", { name: "recoveryEmail", type: "email", placeholder: "Recovery email (optional)" }),
            el("input", { name: "recoveryPhone", placeholder: "Recovery phone (optional)", inputMode: "tel" }),
            (() => { const country = el("select", { name: "recoveryPhoneCountry" }); [["", "Phone country (if local number)"], ["NG", "Nigeria"], ["US", "United States"], ["GB", "United Kingdom"], ["CA", "Canada"], ["OTHER", "Other"]].forEach(([value, text]) => country.append(el("option", { value, text }))); const manual = el("input", { name: "recoveryPhoneCountryName", placeholder: "Enter your country", hidden: true }); country.addEventListener("change", () => { manual.hidden = country.value !== "OTHER"; }); return el("div", {}, country, manual); })(),
            (() => {
              const roleSelect = el("select", { name: "roleId", required: true });
              roleSelect.append(el("option", { value: "", text: "Select an Administrator role" }));
              roles.filter((role) => role.name !== "Super Administrator").forEach((role) =>
                roleSelect.append(el("option", { value: role.id, text: role.name })),
              );
              return roleSelect;
            })(),
            button("Create / invite admin", "invite-admin-form", "primary-button"),
          ),
        ),
        panel(
          table(
            [
              "Administrator",
              "Role",
              "Status",
              "MFA",
              "Last login",
              "Recovery",
              "Change role",
              "Action",
            ],
            rows,
          ),
        ),
        panel(
          el("h3", { text: "Role permissions" }),
          ...roles.map((role) => {
            const permissionForm = el("form", { class: "drawer-form", "data-role-permission-form": role.id },
              el("strong", { text: role.name }),
              ...permissions.map((permission) => el("label", { class: "check-label" },
                el("input", { type: "checkbox", name: "permission", value: permission.code, checked: role.permissions.includes(permission.code), disabled: role.name === "Super Administrator" }),
                el("span", { text: `${permission.code} — ${permission.description}` }),
              )),
              role.name === "Super Administrator" ? el("span", { class: "status danger", text: "Protected" }) : button("Save role permissions", "save-role-permissions", "secondary-button small", { id: role.id }),
            );
            return el("details", {}, el("summary", { text: role.name }), permissionForm);
          }),
        ),
        panel(
          el("h3", { text: "Login history" }),
          table(["Time", "Administrator", "Result", "IP", "Device"], loginHistory.map((entry) => [date(entry.created_at), entry.full_name || "Unknown account", entry.succeeded ? "Successful" : "Failed", entry.ip_address || "—", entry.user_agent || "—"])),
        ),
      );
      page.dataset.roles = JSON.stringify(roles);
      page.dataset.permissions = JSON.stringify(permissions);
    },
    async audit(page) {
      const rows = await api("/admin/audit-logs");
      page.replaceChildren(
        heading(
          "SECURITY HISTORY",
          names.audit,
          "Immutable operational and security actions.",
        ),
        panel(
          table(
            [
              "Time",
              "Action",
              "Entity",
              "Administrator",
              "Reason",
              "Request ID",
            ],
            rows.map((row) => [
              date(row.created_at),
              row.action,
              row.entity_type,
              row.admin_user_id || "System",
              row.reason || "—",
              row.request_id || "—",
            ]),
          ),
        ),
      );
    },
    async settings(page) {
      const settings = await api("/admin/settings");
      const business = settings.business_profile || {};
      const notificationPreferences = settings.notification_preferences || {};
      const settingsForm = el(
        "form",
        { class: "panel drawer-form", id: "api-settings-form" },
        el(
          "label",
          {},
          "Business name",
          el("input", {
            name: "businessName",
            value: business.businessName || "",
          }),
        ),
        el("p", {
          class: "muted",
          text: "PayPal, Cash App, Chime and bank transfer use administrator-assigned off-site instructions and manual verification.",
        }),
        el(
          "label",
          {},
          el("input", {
            name: "adminAlerts",
            type: "checkbox",
            checked: notificationPreferences.adminAlerts !== false,
          }),
          " Prepare admin activity notifications",
        ),
        el(
          "label",
          {},
          "Support email",
          el("input", {
            name: "supportEmail",
            type: "email",
            value: business.supportEmail || "",
          }),
        ),
        el(
          "label",
          {},
          "Order hold minutes",
          el("input", {
            name: "holdMinutes",
            type: "number",
            min: 5,
            max: 30,
            value: settings.order_hold_minutes || 15,
          }),
        ),
        button("Save settings", "save-settings", "primary-button"),
      );
      const passwordForm = el(
        "form",
        { class: "panel drawer-form", id: "admin-password-form" },
        el("h3", { text: "Change password" }),
        el("p", { class: "muted", text: "Your current password is required. Saving revokes every administrator session, including this one." }),
        el("label", {}, "Current password", el("input", { name: "currentPassword", type: "password", autocomplete: "current-password", required: true })),
        el("label", {}, "New password", el("input", { name: "newPassword", type: "password", autocomplete: "new-password", minlength: 8, pattern: "(?=.*[A-Za-z])(?=.*[0-9]).{8,}", title: "Use at least 8 characters, including a letter and a number.", required: true })),
        el("label", {}, "Confirm new password", el("input", { name: "confirmPassword", type: "password", autocomplete: "new-password", minlength: 8, required: true })),
        button("Change password", "change-admin-password", "danger-button"),
      );
      page.replaceChildren(
        heading(
          "CONFIGURATION",
          names.settings,
          "Server-stored business, payment, hold and notification settings.",
        ),
        settingsForm,
        passwordForm,
      );
    },
  };
  async function load(route) {
    const page = pages.get(route);
    if (!page) return;
    renderState(page, "Loading…");
    try {
      await loaders[route](page);
      if (route !== "overview") await refreshNavigationCounts();
    } catch (error) {
      renderState(page, error.message, true);
    }
  }
  async function navigate(route) {
    if (!pages.has(route)) route = "overview";
    pages.forEach((page, key) => {
      page.hidden = key !== route;
      page.classList.toggle("is-active", key === route);
    });
    document.querySelectorAll("[data-admin-route]").forEach((link) => {
      const active = link.dataset.adminRoute === route;
      link.classList.toggle("is-active", active);
      active
        ? link.setAttribute("aria-current", "page")
        : link.removeAttribute("aria-current");
    });
    title.textContent = names[route];
    document.title = `${names[route]} | Live Admin`;
    history.replaceState({}, "", `#${route}`);
    closeSidebar();
    await load(route);
  }
  function closeSidebar() {
    sidebar?.classList.remove("is-open");
    if (backdrop) backdrop.hidden = true;
    document.body.classList.remove("locked");
  }
  document.addEventListener("click", async (event) => {
    const route =
      event.target.closest("[data-admin-route]")?.dataset.adminRoute;
    if (route) {
      event.preventDefault();
      return navigate(route);
    }
    const control = event.target.closest("[data-action]");
    if (!control) return;
    const action = control.dataset.action;
    if (action === "close-recovery") {
      document.getElementById("admin-recovery-dialog").hidden = true;
      recoveryResetToken = "";
      return;
    }
    if (action === "send-recovery-code" || action === "resend-recovery-code") {
      const recoveryForm = document.getElementById("admin-recovery-form");
      const email = recoveryForm.elements["recovery-email"].value;
      if (!email) return toast("Enter your administrator login email.", "error");
      try {
        const result = await api(`/auth/admin/recovery/${action === "send-recovery-code" ? "request" : "resend"}`, { method: "POST", body: JSON.stringify({ email }) });
        document.getElementById("recovery-code-fields").hidden = false;
        document.getElementById("recovery-message").textContent = result.maskedEmail ? `${result.message} Email: ${result.maskedEmail}` : result.message;
        toast("If the recovery details match, a code has been sent.");
      } catch (error) { toast(error.message, "error"); }
      return;
    }
    if (action === "verify-recovery-code") {
      const recoveryForm = document.getElementById("admin-recovery-form");
      try {
        const result = await api("/auth/admin/recovery/verify", { method: "POST", body: JSON.stringify({ email: recoveryForm.elements["recovery-email"].value, code: recoveryForm.elements["recovery-code"].value }) });
        recoveryResetToken = result.resetToken;
        document.getElementById("recovery-password-fields").hidden = false;
        toast("Code verified. Create a new password.", "success");
      } catch (error) { toast(error.message, "error"); }
      return;
    }
    if (action === "reset-admin-password") {
      const recoveryForm = document.getElementById("admin-recovery-form");
      const body = {
        email: recoveryForm.elements["recovery-email"].value,
        resetToken: recoveryResetToken,
        newPassword: recoveryForm.elements["recovery-new-password"].value,
        confirmPassword: recoveryForm.elements["recovery-confirm-password"].value,
      };
      try {
        await api("/auth/admin/recovery/reset", { method: "POST", body: JSON.stringify(body) });
        document.getElementById("admin-recovery-dialog").hidden = true;
        recoveryForm.reset();
        recoveryResetToken = "";
        toast("Password reset. Sign in with your new password.", "success");
      } catch (error) { toast(error.message, "error"); }
      return;
    }
    if (action === "open-sidebar") {
      sidebar?.classList.add("is-open");
      if (backdrop) backdrop.hidden = false;
      return;
    }
    if (action === "close-sidebar") return closeSidebar();
    if (action === "refresh") return load("overview");
    if (action === "admin-logout") {
      try {
        await api("/auth/admin/logout", { method: "POST", body: "{}" });
      } finally {
        csrfToken = "";
        clearAuthTokens();
        showAuthenticated(false);
        if ("caches" in window) {
          const keys = await caches.keys();
          await Promise.all(
            keys
              .filter((key) => key.startsWith("live-admin-"))
              .map((key) => caches.delete(key)),
          );
        }
      }
      return;
    }
    if (action === "create-event") {
      const values = await promptFields([
        ["title", "Event title"],
        ["venue", "Venue"],
        ["city", "City"],
        ["country", "Country code (2 letters)", "NG"],
        ...eventDateTimeFields(),
        ["currency", "Currency", "USD"],
        ["sectionName", "First ticket section", "General Admission"],
        ["sectionDescription", "Section description", "Order-request section"],
        ["sectionPriceMinor", "Ticket price in smallest currency unit"],
        ["sectionAvailableQuantity", "Available ticket quantity"],
      ]);
      if (!values) return;
      try {
        await api("/admin/events", {
          method: "POST",
          body: JSON.stringify({
            title: values.title,
            venue: values.venue,
            city: values.city,
            country: values.country,
            startsAt: eventStartsAt(values),
            currency: values.currency,
            description: "",
            section: {
              name: values.sectionName,
              description: values.sectionDescription,
              priceMinor: Number(values.sectionPriceMinor),
              availableQuantity: Number(values.sectionAvailableQuantity),
            },
          }),
        });
        toast("Event created.", "success");
        await load("events");
      } catch (error) {
        toast(error.message, "error");
      }
      return;
    }
    if (action === "event-status")
      return mutate(
        `/admin/events/${control.dataset.id}/status`,
        { status: control.dataset.status },
        "events",
        "Event status updated.",
      );
    if (action === "delete-event")
      return confirm(
        "Delete event",
        `Archive ${control.dataset.title || "this event"}? Existing payments will not be changed.`,
        () => mutate(`/admin/events/${control.dataset.id}`, {}, "events", "Event deleted.", "DELETE"),
        "Delete",
      );
    if (action === "edit-event") {
      const values = await promptFields([
        ["title", "Event title", control.dataset.title],
        ["venue", "Venue", control.dataset.venue],
        ["city", "City", control.dataset.city],
        ["country", "Country code", control.dataset.country],
        ...eventDateTimeFields(control.dataset.startsAt),
        ["currency", "Currency", control.dataset.currency],
        ["description", "Description", control.dataset.description],
      ]);
      if (values)
        return mutate(
          `/admin/events/${control.dataset.id}`,
          { ...values, startsAt: eventStartsAt(values) },
          "events",
          "Event updated.",
          "PATCH",
        );
    }
    if (action === "add-section") {
      const values = await promptFields([
        ["name", "Section name"],
        ["description", "Description", "Order-request section"],
        ["priceMinor", "Price in smallest currency unit"],
        ["availableQuantity", "Available quantity"],
      ]);
      if (!values) return;
      values.priceMinor = Number(values.priceMinor);
      values.availableQuantity = Number(values.availableQuantity);
      return mutate(
        `/admin/events/${control.dataset.id}/sections`,
        values,
        "events",
        "Section created.",
        "POST",
      );
    }
    if (action === "edit-inventory") {
      const values = await promptFields([
        [
          "priceMinor",
          "Price in smallest currency unit",
          control.dataset.price,
        ],
        [
          "availableQuantity",
          "Total available quantity",
          control.dataset.quantity,
        ],
      ]);
      if (!values) return;
      values.priceMinor = Number(values.priceMinor);
      values.availableQuantity = Number(values.availableQuantity);
      return mutate(
        `/admin/sections/${control.dataset.id}/inventory`,
        values,
        "tickets",
        "Inventory updated.",
        "PATCH",
      );
    }
    if (action === "manual-payment") {
      const confirming = control.dataset.decision === "confirm";
      const values = await promptFields(
        [["reason", "Audit reason", "", "textarea"]],
        confirming ? "Confirm Payment" : "Reject payment",
        "Continue",
      );
      if (!values?.reason) return toast("An audit reason is required.", "error");
      return confirm(
        confirming ? "Confirm Payment" : "Reject payment",
        confirming
          ? "Confirm the exact amount, currency and customer reference are visible in the actual receiving account. A customer claim or receipt is not proof."
          : "Reject this manual payment submission?",
        async () => {
          await mutate(
            `/admin/payments/${control.dataset.id}/${control.dataset.decision}`,
            confirming
              ? {
                  reason: values.reason,
                  confirmedAmountMinor: Number(control.dataset.amount),
                  confirmedCurrency: control.dataset.currency,
                }
              : { reason: values.reason },
            "payments",
            confirming
              ? "Payment successful. Your payment has been confirmed."
              : "Payment rejected.",
            "POST",
          );
        },
        confirming ? "Confirm Payment" : "Reject",
      );
    }
    if (action === "assign-details") {
      const values = await promptPaymentDetails(control);
      if (values) {
        const expiresAt = new Date(Date.now() + Number(values.expiresInHours) * 60 * 60 * 1000).toISOString();
        return mutate(
          `/admin/payments/${control.dataset.id}/assign-details`,
          {
            ...values,
            amountMinor: Number(control.dataset.amount),
            currency: control.dataset.currency,
            expiresAt,
          },
          "payments",
          "Payment details assigned and the customer was notified.",
        );
      }
    }
    if (action === "view-evidence") {
      try {
        const data = await api(
          `/admin/payments/${control.dataset.id}/evidence`,
        );
        if (data.giftCardCode) toast(`Gift Card code: ${data.giftCardCode}`, "success");
        if (data.signedUrl) window.open(data.signedUrl, "_blank", "noopener,noreferrer");
        if (!data.giftCardCode && !data.signedUrl) toast(data.notice);
      } catch (error) {
        toast(error.message, "error");
      }
      return;
    }
    if (action === "service-update") {
      const values = await promptFields([
        [
          "status",
          "Status: assigned, in_progress, waiting_customer, resolved, archived",
          "in_progress",
        ],
        ["internalNotes", "Internal notes"],
        ["assignedTo", "Assign to administrator UUID (optional)"],
        ["replyDraft", "Reply draft (preparation only)"],
      ]);
      if (values)
        return mutate(
          `/admin/service-requests/${control.dataset.id}`,
          values,
          "services",
          "Service request updated.",
          "PATCH",
        );
    }
    if (action === "invite-admin-form") {
      event.preventDefault();
      const inviteForm = document.getElementById("admin-invite-form");
      if (!inviteForm.reportValidity()) return;
      return mutate(
        "/admin/admins/invite",
        Object.fromEntries(new FormData(inviteForm)),
        "team",
        "Administrator invitation sent.",
        "POST",
      );
    }
    if (action === "invite-admin") {
      let roles = [];
      try {
        roles = JSON.parse(pages.get("team").dataset.roles || "[]");
      } catch {}
      const values = await promptFields([
        ["fullName", "Full name"],
        ["email", "Email"],
        ["recoveryEmail", "Recovery email (optional)"],
        ["recoveryPhone", "Recovery phone (optional)"],
        ["recoveryPhoneCountry", "Phone country (optional, for local numbers)", "NG"],
        ["recoveryPhoneCountryName", "Recovery phone country name (optional)"],
        ["password", "Password", "", "password"],
        ["confirmPassword", "Confirm password", "", "password"],
        [
          "roleId",
          `Role ID: ${roles
            .filter((r) => r.name !== "Super Administrator")
            .map((r) => `${r.name}=${r.id}`)
            .join(", ")}`,
        ],
      ]);
      if (values)
        return mutate(
          "/admin/admins/invite",
          values,
          "team",
          "Administrator invitation sent.",
          "POST",
        );
    }
    if (action === "admin-status")
      return confirm(
        control.dataset.status === "disabled" ? "Deactivate administrator" : "Activate administrator",
        "Change this administrator's access status? This action is audited.",
        () => mutate(`/admin/admins/${control.dataset.id}/status`, { status: control.dataset.status }, "team", "Administrator status updated.", "PATCH"),
      );
    if (action === "admin-recovery") {
      const values = await promptFields([["recoveryEmail", "Recovery email (optional)"], ["recoveryPhone", "Recovery phone (optional)"], ["recoveryPhoneCountry", "Phone country (optional, for local numbers)", "NG"], ["recoveryPhoneCountryName", "Recovery phone country name (optional)"]], "Recovery details");
      if (values) return mutate(`/admin/admins/${control.dataset.id}/recovery`, values, "team", "Recovery details updated.", "PATCH");
    }
    if (action === "save-role-permissions") {
      event.preventDefault();
      const roleForm = pages.get("team").querySelector(`[data-role-permission-form="${control.dataset.id}"]`);
      const permissions = new FormData(roleForm).getAll("permission");
      return mutate(`/admin/roles/${control.dataset.id}/permissions`, { permissions }, "team", "Role permissions updated.", "PATCH");
    }
    if (action === "remove-admin")
      return confirm(
        "Remove administrator",
        "Remove this administrator’s access?",
        () =>
          mutate(
            `/admin/admins/${control.dataset.id}`,
            {},
            "team",
            "Administrator removed.",
            "DELETE",
          ),
        "Remove",
      );
    if (action === "save-settings") {
      event.preventDefault();
      const values = new FormData(document.getElementById("api-settings-form"));
      return mutate(
        "/admin/settings",
        {
          business_profile: {
            businessName: values.get("businessName"),
            supportEmail: values.get("supportEmail"),
          },
          order_hold_minutes: Number(values.get("holdMinutes")),
          notification_preferences: {
            adminAlerts: values.get("adminAlerts") === "on",
          },
        },
        "settings",
        "Settings saved.",
        "PATCH",
      );
    }
    if (action === "change-admin-password") {
      event.preventDefault();
      const passwordForm = document.getElementById("admin-password-form");
      if (!passwordForm.reportValidity()) return;
      const values = Object.fromEntries(new FormData(passwordForm));
      if (values.newPassword !== values.confirmPassword) return toast("New password confirmation does not match.", "error");
      return confirm("Change password", "Change your password and revoke all administrator sessions?", async () => {
        try {
          await api("/auth/admin/change-password", { method: "POST", body: JSON.stringify(values) });
          csrfToken = "";
          showAuthenticated(false);
          toast("Password changed. Sign in again.", "success");
        } catch (error) { toast(error.message, "error"); }
      }, "Change password");
    }
    if (action === "notifications") {
      try {
        const rows = await api("/admin/notifications");
        toast(
          rows.length
            ? `${rows.filter((row) => !row.read_at).length} unread notifications.`
            : "No notifications.",
        );
      } catch (error) {
        toast(error.message, "error");
      }
    }
  });
  async function mutate(path, body, route, message, method = "POST") {
    try {
      await api(path, { method, body: JSON.stringify(body) });
      toast(message, "success");
      await load(route);
    } catch (error) {
      toast(error.message, "error");
    }
  }
  form?.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    const submit = form.querySelector('[type="submit"]');
    submit.disabled = true;
    try {
      const data = new FormData(form);
      const result = await api("/auth/admin/login", {
        method: "POST",
        headers: { "X-Auth-Transport": "bearer-fallback" },
        body: JSON.stringify({
          email: data.get("admin-email"),
          password: data.get("admin-password"),
        }),
      });
      csrfToken = result.csrfToken;
      saveAuthTokens(result);
      await api("/admin/overview");
      showAuthenticated(true);
      await navigate(window.location.hash.slice(1) || "overview");
      toast("Administrator session started.", "success");
    } catch (error) {
      clearAuthTokens();
      showAuthenticated(false);
      toast(error.message, "error");
    } finally {
      submit.disabled = false;
    }
  });
  document
    .querySelector('[data-action="toggle-password"]')
    ?.addEventListener("click", (event) => {
      const input = form.querySelector('[name="admin-password"]');
      input.type = input.type === "password" ? "text" : "password";
      event.currentTarget.textContent =
        input.type === "password" ? "Show" : "Hide";
    });
  document
    .querySelector('[data-action="forgot-admin-password"]')
    ?.addEventListener("click", async () => {
      const dialog = document.getElementById("admin-recovery-dialog");
      document.getElementById("recovery-code-fields").hidden = true;
      document.getElementById("recovery-password-fields").hidden = true;
      document.getElementById("recovery-message").textContent = "Enter your administrator login email.";
      dialog.hidden = false;
      dialog.querySelector('[name="recovery-email"]').focus();
    });
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredInstallPrompt = event;
    document
      .querySelectorAll("#install-admin-app,[data-action='install-pwa']")
      .forEach((button) => (button.hidden = false));
  });
  document
    .querySelectorAll("#install-admin-app,[data-action='install-pwa']")
    .forEach((button) =>
      button.addEventListener("click", async () => {
        if (!deferredInstallPrompt)
          return toast(
            "Install is available only from a supported HTTPS browser.",
          );
        await deferredInstallPrompt.prompt();
        await deferredInstallPrompt.userChoice;
        deferredInstallPrompt = null;
      }),
    );
  if ("serviceWorker" in navigator)
    window.addEventListener("load", async () => {
      try {
        const registration =
          await navigator.serviceWorker.register("admin-sw.js?v=5");
        registration.addEventListener("updatefound", () =>
          registration.installing?.addEventListener("statechange", () => {
            if (
              registration.installing?.state === "installed" &&
              navigator.serviceWorker.controller
            )
              toast("An admin app update is ready. Reload to apply it.");
          }),
        );
      } catch {
        toast("Admin app installation is unavailable.", "error");
      }
    });
  (async () => {
    try {
      const refreshed = await api("/auth/admin/refresh", {
        method: "POST",
        headers: { "X-Auth-Transport": "bearer-fallback" },
        body: JSON.stringify({ refreshToken: authTokens?.refreshToken || "" }),
      });
      csrfToken = refreshed.csrfToken;
      saveAuthTokens(refreshed);
      await api("/admin/overview");
      showAuthenticated(true);
      await navigate(window.location.hash.slice(1) || "overview");
    } catch {
      showAuthenticated(false);
    }
  })();
});
