document.addEventListener("DOMContentLoaded", () => {
  const apiBase = (document.querySelector('meta[name="public-api-base-url"]')?.content || "").replace(/\/$/, "");
  const pages = [...document.querySelectorAll("[data-page]")];
  const state = { eventId: "", sectionId: "", orderNumber: "", orderAccessToken: "", sectionName: "", ticketPrice: 0, ticketQuantity: 1, currency: "USD", paymentMethod: "paypal" };
  const menuButton = document.querySelector('[data-action="toggle-menu"]');
  const mobileMenu = document.getElementById("mobile-menu");
  const setMobileMenu = (open) => {
    if (!menuButton || !mobileMenu) return;
    mobileMenu.hidden = !open;
    menuButton.setAttribute("aria-expanded", String(open));
  };
  const api = async (path, options = {}, guest = false) => {
    const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
    if (guest && state.orderAccessToken) headers["X-Order-Access-Token"] = state.orderAccessToken;
    const response = await fetch(`${apiBase}/api/v1${path}`, { credentials: "include", ...options, headers });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error?.message || "Request failed. Please try again.");
    return payload.data;
  };
  const toastRegion = document.getElementById("toast-region");
  const showToast = (message, type = "info") => {
    if (!toastRegion) return;
    const item = document.createElement("div"); item.className = `toast toast-${type}`; item.textContent = message; item.setAttribute("role", type === "error" ? "alert" : "status"); toastRegion.append(item); setTimeout(() => item.remove(), 4000);
  };
  const route = (name) => {
    if (name === "event-details" && !state.eventId) name = "home";
    pages.forEach((page) => { const active = page.dataset.page === name; page.hidden = !active; page.classList.toggle("is-active", active); });
    document.querySelectorAll("[data-route]").forEach((control) => control.classList.toggle("is-active", control.dataset.route === name));
    setMobileMenu(false);
    if (name === "payments") populateOrderAccessForm();
    if (window.location.hash !== `#${name}`) history.pushState({}, "", `#${name}`);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  const displayMoney = (minor, currency) => { try { return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(Number(minor || 0) / 100); } catch { return `${currency} ${Number(minor || 0) / 100}`; } };
  const emptyState = (message) => Object.assign(document.createElement("p"), { className: "panel-description", textContent: message });
  const renderEventRow = (event) => {
    const item = document.createElement("article");
    item.className = "event-row";
    const starts = new Date(event.starts_at);
    const dateBlock = document.createElement("div"); dateBlock.className = "date-block";
    dateBlock.append(Object.assign(document.createElement("span"), { textContent: starts.toLocaleString(undefined, { month: "short" }).toUpperCase() }), Object.assign(document.createElement("strong"), { textContent: String(starts.getDate()).padStart(2, "0") }), Object.assign(document.createElement("small"), { textContent: starts.toLocaleString(undefined, { weekday: "short" }).toUpperCase() }));
    const main = document.createElement("div"); main.className = "event-row-main";
    main.append(Object.assign(document.createElement("p"), { className: "event-type", textContent: "Live event" }), Object.assign(document.createElement("h3"), { textContent: event.title }), Object.assign(document.createElement("p"), { textContent: `${starts.toLocaleString()} • ${event.venue}, ${event.city}` }));
    const price = document.createElement("div"); price.className = "event-row-price"; price.append(Object.assign(document.createElement("span"), { textContent: "From" }), Object.assign(document.createElement("strong"), { textContent: displayMoney(event.starting_price_minor, event.currency) }));
    const button = document.createElement("button"); button.className = "button button-primary button-small"; button.type = "button"; button.textContent = "View options"; button.addEventListener("click", () => loadEvent(event.slug));
    item.append(dateBlock, main, price, button); return item;
  };
  const renderFeaturedEvent = (event) => {
    const item = document.createElement("article"); item.className = "event-card";
    const content = document.createElement("div"); content.className = "event-card-content";
    const starts = new Date(event.starts_at);
    content.append(Object.assign(document.createElement("p"), { className: "event-type", textContent: "Live event" }), Object.assign(document.createElement("h3"), { textContent: event.title }));
    const meta = document.createElement("p"); meta.className = "muted"; meta.textContent = `${starts.toLocaleString()} • ${event.venue}, ${event.city}`; content.append(meta);
    const footer = document.createElement("div"); footer.className = "event-card-footer"; footer.append(Object.assign(document.createElement("p"), { className: "event-price", textContent: `From ${displayMoney(event.starting_price_minor, event.currency)}` }));
    const button = document.createElement("button"); button.className = "button button-primary button-small"; button.type = "button"; button.textContent = "View options"; button.addEventListener("click", () => loadEvent(event.slug)); footer.append(button); content.append(footer); item.append(content); return item;
  };
  const renderEvents = (events) => {
    const list = document.getElementById("event-list"); const featured = document.getElementById("featured-event-list"); const count = document.getElementById("event-count");
    if (count) count.textContent = String(events.length);
    if (list) { list.replaceChildren(); if (!events.length) list.append(emptyState("No published events are currently available.")); else events.forEach((event) => list.append(renderEventRow(event))); }
    if (featured) { featured.replaceChildren(); if (!events.length) featured.append(emptyState("No published events are currently available.")); else events.slice(0, 2).forEach((event) => featured.append(renderFeaturedEvent(event))); }
  };
  const loadEvents = async (query = "", filters = {}) => { const params = new URLSearchParams(); if (query) params.set("q", query); if (filters.city) params.set("city", filters.city); if (filters.from) params.set("from", filters.from); if (filters.to) params.set("to", filters.to); try { renderEvents(await api(`/events${params.size ? `?${params}` : ""}`)); } catch (error) { const message = "Published events are unavailable right now."; document.getElementById("event-list")?.replaceChildren(emptyState(message)); document.getElementById("featured-event-list")?.replaceChildren(emptyState(message)); showToast(error.message, "error"); } };
  const loadEvent = async (slug) => {
    try { const event = await api(`/events/${encodeURIComponent(slug)}`); state.eventId = event.id; state.currency = event.currency; state.sectionId = ""; state.sectionName = ""; state.ticketPrice = 0; const starts = new Date(event.starts_at); document.getElementById("event-details-title").textContent = event.title; document.getElementById("event-details-date").textContent = starts.toLocaleString(); document.getElementById("event-details-location").textContent = `${event.venue} • ${event.city}, ${event.country}`; document.getElementById("summary-event-title").textContent = event.title; document.getElementById("summary-event-date").textContent = starts.toLocaleString(); document.getElementById("summary-event-location").textContent = `${event.venue} • ${event.city}`; document.getElementById("checkout-event-title").textContent = event.title; document.getElementById("checkout-event-date").textContent = starts.toLocaleString(); document.getElementById("checkout-event-location").textContent = `${event.venue} • ${event.city}`; const list = document.querySelector(".ticket-option-list"); if (list) { list.replaceChildren(); event.sections.forEach((section, index) => { const label = document.createElement("label"); label.className = `ticket-option${index === 0 ? " is-selected" : ""}`; const input = document.createElement("input"); input.type = "radio"; input.name = "ticket-option"; input.value = section.id; input.checked = index === 0; const main = document.createElement("span"); main.className = "ticket-option-main"; main.append(Object.assign(document.createElement("strong"), { textContent: section.name }), Object.assign(document.createElement("span"), { className: "ticket-benefits", textContent: section.description || "Order request section" }), Object.assign(document.createElement("span"), { className: "scarcity", textContent: `${section.available_quantity} currently available` })); const price = document.createElement("span"); price.className = "ticket-option-price"; price.append(Object.assign(document.createElement("small"), { textContent: "Each" }), Object.assign(document.createElement("strong"), { textContent: displayMoney(section.price_minor, event.currency) })); label.append(input, main, price); input.addEventListener("change", () => { state.sectionId = section.id; state.sectionName = section.name; state.ticketPrice = Number(section.price_minor) / 100; updateSummary(); }); list.append(label); if (index === 0) { state.sectionId = section.id; state.sectionName = section.name; state.ticketPrice = Number(section.price_minor) / 100; } }); } updateSummary(); route("event-details"); } catch (error) { showToast(error.message, "error"); }
  };
  const updateSummary = () => { const total = state.ticketPrice * state.ticketQuantity; const quantity = `${state.ticketQuantity} ${state.ticketQuantity === 1 ? "ticket" : "tickets"}`; const values = { "summary-section": state.sectionName || "—", "summary-quantity": quantity, "summary-subtotal": state.sectionId ? displayMoney(total * 100, state.currency) : "—", "summary-total": state.sectionId ? displayMoney(total * 100, state.currency) : "—", "checkout-section-name": state.sectionName || "No section selected", "checkout-ticket-count": `${quantity} requested` }; Object.entries(values).forEach(([id, value]) => { const node = document.getElementById(id); if (node) node.textContent = value; }); };
  const populateOrderAccessForm = () => {
    const form = document.getElementById("guest-order-access-form");
    if (!form) return;
    form.elements["order-reference"].value = state.orderNumber;
    form.elements["order-access-token"].value = state.orderAccessToken;
  };
  const persistGuestOrder = () => {
    try { sessionStorage.setItem("guest-order", JSON.stringify({ reference: state.orderNumber, accessToken: state.orderAccessToken })); } catch {}
  };
  const renderPaymentDetails = (details) => {
    const content = document.getElementById("payment-details-content");
    if (!content) return;
    content.replaceChildren();
    const fields = [
      ["Payment method", details.payment_method],
      ["Bank name", details.bank_name],
      ["Account name", details.account_name],
      ["Account number", details.account_number],
      ["Payment identifier", details.payment_identifier],
      ["Payment reference", details.payment_reference],
      ["Amount", displayMoney(details.amount_minor, details.currency)],
      ["Instructions", details.instructions],
      ["Expires", details.expires_at ? new Date(details.expires_at).toLocaleString() : "Not specified"],
    ];
    fields.filter(([, value]) => value).forEach(([label, value]) => {
      const row = document.createElement("div");
      row.append(Object.assign(document.createElement("strong"), { textContent: label }), Object.assign(document.createElement("span"), { textContent: String(value) }));
      content.append(row);
    });
    document.getElementById("payment-details-dialog").hidden = false;
  };
  const loadOrderStatus = async (reference, accessToken) => {
    state.orderNumber = reference.trim();
    state.orderAccessToken = accessToken.trim();
    if (!state.orderNumber || !state.orderAccessToken) throw new Error("Enter both your order reference and access code.");
    persistGuestOrder();
    const order = await api(`/orders/${encodeURIComponent(state.orderNumber)}`, {}, true);
    const status = document.getElementById("payment-center-status");
    status.textContent = `${order.reference}: ${String(order.current_payment_status || order.payment_status).replaceAll("_", " ")}`;
    if (order.current_payment_status === "payment_details_ready" && order.payment_id) {
      const details = await api(`/orders/${encodeURIComponent(state.orderNumber)}/payments/${order.payment_id}/instructions`, {}, true);
      renderPaymentDetails(details);
    }
  };
  document.getElementById("guest-order-access-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    try {
      await loadOrderStatus(form.elements["order-reference"].value, form.elements["order-access-token"].value);
    } catch (error) {
      document.getElementById("payment-center-status").textContent = error.message;
      showToast(error.message, "error");
    }
  });
  document.querySelectorAll("[data-payment-dialog-close]").forEach((control) => control.addEventListener("click", () => { document.getElementById("payment-details-dialog").hidden = true; }));
  menuButton?.addEventListener("click", () => setMobileMenu(mobileMenu.hidden));
  document.querySelectorAll("[data-route]").forEach((control) => control.addEventListener("click", (event) => { const name = control.dataset.route; if (!pages.some((page) => page.dataset.page === name)) return; event.preventDefault(); route(name); }));
  document.querySelectorAll('input[name="ticket-quantity"]').forEach((input) => input.addEventListener("change", () => { state.ticketQuantity = Number(input.value) || 1; updateSummary(); }));
  document.querySelectorAll('input[name="payment-method"]').forEach((input) => input.addEventListener("change", () => { state.paymentMethod = input.value.replace("-", "_"); document.querySelectorAll("[data-payment-panel]").forEach((panel) => { panel.hidden = panel.dataset.paymentPanel !== input.value; }); }));
  document.querySelector('select[name="phone-country"]')?.addEventListener("change", (event) => { document.querySelector("[data-other-country-field]")?.toggleAttribute("hidden", event.target.value !== "OTHER"); });
  document.getElementById("checkout-form")?.addEventListener("submit", async (event) => { event.preventDefault(); const form = event.currentTarget; if (!form.reportValidity() || !state.eventId || !state.sectionId) return; const data = new FormData(form); const button = form.querySelector('button[type="submit"]'); button.disabled = true; try { const result = await api("/orders", { method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify({ eventId: state.eventId, sectionId: state.sectionId, quantity: state.ticketQuantity, paymentMethod: state.paymentMethod, contactName: `${data.get("first-name")} ${data.get("last-name")}`.trim(), contactEmail: data.get("email"), contactPhone: data.get("phone"), contactCountry: data.get("phone-country") === "OTHER" ? data.get("phone-country-name") : data.get("phone-country") }) }); state.orderNumber = result.reference; state.orderAccessToken = result.accessToken; persistGuestOrder(); const orderNumber = document.getElementById("order-number"); if (orderNumber) orderNumber.textContent = result.reference; const accessCode = document.getElementById("order-access-token"); if (accessCode) accessCode.textContent = result.accessToken; const status = document.getElementById("payment-status-message"); if (status) status.textContent = result.message; populateOrderAccessForm(); route("success"); } catch (error) { showToast(error.message, "error"); } finally { button.disabled = false; } });
  const serviceForm = document.getElementById("service-form"); serviceForm?.addEventListener("submit", async (event) => { event.preventDefault(); if (!serviceForm.reportValidity()) return; const data = new FormData(serviceForm); try { await api("/service-requests", { method: "POST", body: JSON.stringify({ category: "general", fullName: data.get("service-name"), email: data.get("service-email"), phone: data.get("service-phone"), message: data.get("service-message") }) }); serviceForm.reset(); showToast("Your enquiry has been received.", "success"); } catch (error) { showToast(error.message, "error"); } });
  const supportForm = document.getElementById("support-form"); supportForm?.addEventListener("submit", async (event) => { event.preventDefault(); if (!supportForm.reportValidity()) return; const data = new FormData(supportForm); try { await api("/support-requests", { method: "POST", body: JSON.stringify({ name: data.get("support-name"), email: data.get("support-email"), orderReference: data.get("order-number"), message: data.get("support-message") }) }); supportForm.reset(); showToast("Your support request has been received.", "success"); } catch (error) { showToast(error.message, "error"); } });
  try { const saved = JSON.parse(sessionStorage.getItem("guest-order") || "null"); if (saved) { state.orderNumber = saved.reference; state.orderAccessToken = saved.accessToken; } } catch {}
  updateSummary(); loadEvents(); route(window.location.hash.replace(/^#/, "") || "home");
});
