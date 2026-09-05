import crypto from "node:crypto";
import { HttpError } from "./http.js";

const ids = {
  adminProfile: "10000000-0000-4000-8000-000000000001",
  admin: "10000000-0000-4000-8000-000000000002",
  role: "10000000-0000-4000-8000-000000000003",
  customer: "10000000-0000-4000-8000-000000000004",
  event: "20000000-0000-4000-8000-000000000001",
  sectionA: "30000000-0000-4000-8000-000000000001",
  sectionB: "30000000-0000-4000-8000-000000000002",
  order: "40000000-0000-4000-8000-000000000001",
  payment: "50000000-0000-4000-8000-000000000001",
};

const now = () => new Date().toISOString();
const clone = (value) => JSON.parse(JSON.stringify(value));

export function createDevelopmentDemo(config) {
  if (config.NODE_ENV !== "development" || !config.DEVELOPMENT_DEMO)
    throw new Error("Development demo services cannot run outside demo mode.");

  const state = {
    profiles: [
      {
        id: ids.adminProfile,
        full_name: "Local Demo Administrator",
        phone: "+1 555 0100",
        country: "Demo",
      },
      {
        id: ids.customer,
        full_name: "Demo Customer",
        phone: "+1 555 0110",
        country: "Demo",
      },
    ],
    events: [
      {
        id: ids.event,
        slug: "midnight-red-live-demo",
        title: "Midnight Red Live",
        description:
          "A fictional local-development event used to inspect the API-connected experience.",
        venue: "Demo Arena",
        city: "Lagos",
        country: "Nigeria",
        starts_at: "2027-02-20T19:30:00.000Z",
        currency: "USD",
        status: "published",
        created_at: now(),
      },
    ],
    sections: [
      {
        id: ids.sectionA,
        event_id: ids.event,
        name: "General Admission",
        description: "Standing admission order request",
        price_minor: 4500,
        available_quantity: 250,
        held_quantity: 3,
        sold_quantity: 42,
      },
      {
        id: ids.sectionB,
        event_id: ids.event,
        name: "Premium Seating",
        description: "Premium-area order request",
        price_minor: 9500,
        available_quantity: 80,
        held_quantity: 1,
        sold_quantity: 18,
      },
    ],
    orders: [
      {
        id: ids.order,
        profile_id: ids.customer,
        event_id: ids.event,
        reference: "ORD-DEMO-1001",
        status: "pending_verification",
        payment_status: "pending_verification",
        total_minor: 9000,
        currency: "USD",
        contact_name: "Demo Customer",
        contact_email: "customer@local.demo",
        quantity: 2,
        created_at: now(),
      },
    ],
    payments: [
      {
        id: ids.payment,
        order_id: ids.order,
        provider: "manual",
        method: "cash_app",
        status: "pending_verification",
        amount_minor: 9000,
        currency: "USD",
        created_at: now(),
      },
    ],
    assignments: [],
    applications: [
      {
        id: "60000000-0000-4000-8000-000000000001",
        profile_id: ids.customer,
        full_name: "Demo Customer",
        email: "customer@local.demo",
        country: "Nigeria",
        reason: "Interested in the community programme.",
        interest: "community",
        status: "pending",
        created_at: now(),
      },
    ],
    memberships: [],
    services: [
      {
        id: "70000000-0000-4000-8000-000000000001",
        profile_id: ids.customer,
        category: "event_planning",
        full_name: "Demo Customer",
        email: "customer@local.demo",
        phone: "+1 555 0110",
        message: "Fictional planning enquiry for local development.",
        status: "new",
        created_at: now(),
        updated_at: now(),
      },
    ],
    support: [],
    audits: [
      {
        id: "80000000-0000-4000-8000-000000000001",
        admin_user_id: ids.admin,
        action: "development.demo_started",
        entity_type: "system",
        created_at: now(),
        metadata: { localOnly: true },
      },
    ],
    settings: {
      business_profile: { name: "LIVE Demo", currency: "USD" },
      payment_methods: {
        paypal: true,
        cash_app: true,
        chime: true,
        bank_transfer: true,
        gift_card: true,
      },
      order_hold_minutes: 15,
      notification_preferences: { manual_payment_review: true },
    },
    checkoutKeys: new Map(),
  };

  const result = (rows = []) => ({ rows: clone(rows) });
  const query = async (text, params = []) => {
    const sql = text.replace(/\s+/g, " ").trim().toLowerCase();
    if (sql.includes("from admin_users au join admin_roles"))
      return result([
        {
          id: ids.admin,
          is_super_admin: true,
          status: "active",
          role: "Super Administrator",
          permissions: [],
        },
      ]);
    if (sql.startsWith("select id, status from admin_users"))
      return result([{ id: ids.admin, status: "active" }]);
    if (sql.includes("pending_orders") && sql.includes("open_services"))
      return result([
        {
          pending_orders: state.orders.filter((x) =>
            [
              "pending_payment",
              "awaiting_payment_details",
              "payment_details_ready",
              "pending_verification",
              "provider_verified",
            ].includes(x.status),
          ).length,
          successful_payments: state.payments.filter(
            (x) => x.status === "successful",
          ).length,
          pending_applications: state.applications.filter((x) =>
            ["pending", "on_hold"].includes(x.status),
          ).length,
          open_services: state.services.filter(
            (x) => !["resolved", "archived"].includes(x.status),
          ).length,
        },
      ]);
    if (sql.includes("from events e join event_sections"))
      return result(
        state.events
          .filter((event) => event.status === "published")
          .map((event) => ({
            ...event,
            starting_price_minor: Math.min(
              ...state.sections
                .filter((section) => section.event_id === event.id)
                .map((section) => section.price_minor),
            ),
          })),
      );
    if (sql.includes("from events where slug=$1"))
      return result(
        state.events.filter(
          (event) => event.slug === params[0] && event.status === "published",
        ),
      );
    if (sql.includes("for update of ti")) {
      const section = state.sections.find(
        (x) => x.id === params[0] && x.event_id === params[1],
      );
      const event = state.events.find((x) => x.id === params[1]);
      return result(
        section && event
          ? [{ ...section, currency: event.currency, status: event.status }]
          : [],
      );
    }
    if (sql.includes("from event_sections es join ticket_inventory"))
      return result(
        state.sections
          .filter((section) => section.event_id === params[0])
          .map((section) => ({
            ...section,
            remaining_quantity:
              section.available_quantity -
              section.held_quantity -
              section.sold_quantity,
            available_quantity: sql.includes("greatest(")
              ? section.available_quantity -
                section.held_quantity -
                section.sold_quantity
              : section.available_quantity,
          })),
      );
    if (sql.startsWith("select * from events")) return result(state.events);
    if (
      sql.startsWith("select id,reference,status,payment_status") &&
      sql.includes("checkout_idempotency_key")
    ) {
      const order = state.checkoutKeys.get(params[0]);
      return result(order ? [{ ...order, reused: true }] : []);
    }
    if (sql.startsWith("insert into orders")) {
      const row = {
        id: crypto.randomUUID(),
        profile_id: params[0],
        event_id: params[1],
        reference: params[2],
        status: "pending_payment",
        payment_status: "pending",
        currency: params[3],
        subtotal_minor: params[4],
        total_minor: params[4],
        contact_name: params[5],
        contact_email: params[6],
        hold_expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
        created_at: now(),
      };
      state.orders.push(row);
      state.checkoutKeys.set(params[7], row);
      return result([row]);
    }
    if (sql.startsWith("insert into order_items")) return result();
    if (sql.startsWith("update orders set status='awaiting_payment_details'")) {
      const order = state.orders.find((x) => x.id === params[0]);
      if (order) {
        order.status = "awaiting_payment_details";
        order.payment_status = "awaiting_payment_details";
      }
      return result();
    }
    if (
      sql.startsWith("update ticket_inventory set held_quantity=held_quantity+")
    ) {
      const section = state.sections.find((x) => x.id === params[0]);
      if (section) section.held_quantity += Number(params[1]);
      return result();
    }
    if (sql.startsWith("insert into payments")) {
      const row = {
        id: crypto.randomUUID(),
        order_id: params[0],
        provider: params[1],
        method: params[2],
        status: params[3],
        amount_minor: params[4],
        currency: params[5],
        created_at: now(),
      };
      state.payments.push(row);
      return result([row]);
    }
    if (sql.startsWith("select p.*,o.reference order_reference")) {
      const payment = state.payments.find((x) => x.id === params[0]);
      const order = state.orders.find((x) => x.id === payment?.order_id);
      return result(payment ? [{ ...payment, order_reference: order?.reference }] : []);
    }
    if (sql.startsWith("insert into payment_assignments")) {
      const row = {
        id: crypto.randomUUID(),
        order_id: params[0],
        payment_id: params[1],
        assigned_by: params[2],
        payment_method: params[3],
        bank_name: params[4],
        account_name: params[5],
        account_number: params[6],
        payment_identifier: params[7],
        payment_reference: params[8],
        amount_minor: params[9],
        currency: params[10],
        instructions: params[11],
        expires_at: params[12],
        status: "active",
        created_at: now(),
      };
      state.assignments.push(row);
      return result([row]);
    }
    if (sql.startsWith("update payments set status='payment_details_ready'")) {
      const payment = state.payments.find((x) => x.id === params[0]);
      if (payment) payment.status = "payment_details_ready";
      return result();
    }
    if (sql.startsWith("update orders set status='payment_details_ready'")) {
      const order = state.orders.find((x) => x.id === params[0]);
      if (order) {
        order.status = "payment_details_ready";
        order.payment_status = "payment_details_ready";
      }
      return result();
    }
    if (sql.includes("from payment_assignments pa join orders o")) {
      const assignment = state.assignments.find(
        (x) =>
          x.payment_id === params[0] &&
          ["active", "submitted"].includes(x.status),
      );
      const order = state.orders.find((x) => x.id === assignment?.order_id);
      return result(
        assignment && order?.profile_id === params[1] ? [assignment] : [],
      );
    }
    if (sql.includes("from orders o join events"))
      return result(
        state.orders.map((order) => ({
          ...order,
          event_title: state.events.find((x) => x.id === order.event_id)?.title,
        })),
      );
    if (
      sql.includes("from payments p join orders") &&
      sql.includes("order_reference")
    )
      return result(
        state.payments.map((payment) => ({
          ...payment,
          order_reference: state.orders.find((x) => x.id === payment.order_id)
            ?.reference,
        })),
      );
    if (
      sql.includes("from membership_applications") &&
      sql.includes("profile_id=$1")
    )
      return result(
        state.applications.filter((x) => x.profile_id === params[0]),
      );
    if (sql.includes("from membership_applications"))
      return result(state.applications);
    if (sql.includes("from service_requests") && sql.includes("profile_id=$1"))
      return result(state.services.filter((x) => x.profile_id === params[0]));
    if (sql.includes("from service_requests")) return result(state.services);
    if (sql.includes("from memberships m")) return result(state.memberships);
    if (sql.includes("from admin_roles"))
      return result([
        {
          id: ids.role,
          name: "Super Administrator",
          description: "Protected local demo role",
        },
        {
          id: "10000000-0000-4000-8000-000000000005",
          name: "Event Manager",
          description: "Events and inventory",
        },
      ]);
    if (sql.includes("from admin_users au") && sql.includes("p.full_name"))
      return result([
        {
          id: ids.admin,
          status: "active",
          is_super_admin: true,
          two_factor_required: true,
          last_login_at: now(),
          role_id: ids.role,
          role: "Super Administrator",
          full_name: "Local Demo Administrator",
        },
      ]);
    if (sql.includes("from audit_logs")) return result(state.audits);
    if (sql.includes("from notifications"))
      return result([
        {
          id: "90000000-0000-4000-8000-000000000001",
          kind: "manual_payment",
          title: "Manual payment awaiting review",
          body: "Demo order ORD-DEMO-1001 requires a business-account check.",
          read_at: null,
          created_at: now(),
        },
      ]);
    if (sql.startsWith("select key,value from app_settings"))
      return result(
        Object.entries(state.settings).map(([key, value]) => ({ key, value })),
      );
    if (sql.startsWith("select id, full_name, phone, country from profiles"))
      return result(state.profiles.filter((x) => x.id === params[0]));
    if (sql.startsWith("update profiles")) {
      const profile = state.profiles.find((x) => x.id === params[0]);
      if (profile)
        Object.assign(profile, {
          full_name: params[1] || profile.full_name,
          phone: params[2] || profile.phone,
          country: params[3] || profile.country,
        });
      return result(profile ? [profile] : []);
    }
    if (sql.includes("from orders o left join lateral"))
      return result(
        state.orders
          .filter((x) => x.profile_id === params[0])
          .map((order) => {
            const payment = state.payments.find((x) => x.order_id === order.id);
            return {
              ...order,
              payment_id: payment?.id,
              method: payment?.method,
              current_payment_status: payment?.status,
            };
          }),
      );
    if (sql.startsWith("insert into membership_applications")) {
      const row = {
        id: crypto.randomUUID(),
        profile_id: params[0],
        full_name: params[1],
        email: params[2],
        country: params[3],
        reason: params[4],
        interest: params[5],
        status: "pending",
        created_at: now(),
      };
      state.applications.push(row);
      return result([row]);
    }
    if (sql.startsWith("insert into service_requests")) {
      const row = {
        id: crypto.randomUUID(),
        profile_id: params[0],
        category: params[1],
        full_name: params[2],
        email: params[3],
        phone: params[4],
        message: params[5],
        status: "new",
        created_at: now(),
        updated_at: now(),
      };
      state.services.push(row);
      return result([row]);
    }
    if (sql.startsWith("insert into customer_support_requests")) {
      const row = { id: crypto.randomUUID(), created_at: now() };
      state.support.push(row);
      return result([row]);
    }
    if (sql.startsWith("insert into audit_logs")) {
      state.audits.unshift({
        id: crypto.randomUUID(),
        action: params[1] || "development.action",
        entity_type: params[2] || "system",
        created_at: now(),
        metadata: params.at(-1) || {},
      });
      return result();
    }
    if (
      sql.startsWith("insert into admin_login_attempts") ||
      sql.startsWith("update admin_users set last_login")
    )
      return result();
    return result();
  };

  const db = {
    query,
    transaction: async (work) => work({ query }),
    close: async () => {},
  };
  const users = {
    "admin@local.demo": {
      id: ids.adminProfile,
      email: "admin@local.demo",
      password: "LocalDemo123!",
    },
    "customer@local.demo": {
      id: ids.customer,
      email: "customer@local.demo",
      password: "LocalDemo123!",
    },
  };
  const sessions = new Map();
  const makeSession = (user) => {
    const access_token = `local-demo-${crypto.randomUUID()}`;
    const session = {
      access_token,
      refresh_token: `local-refresh-${crypto.randomUUID()}`,
      expires_in: 3600,
    };
    sessions.set(access_token, user);
    return session;
  };
  const authApi = {
    signInWithPassword: async ({ email, password }) => {
      const user = users[String(email).toLowerCase()];
      return user && user.password === password
        ? { data: { user, session: makeSession(user) }, error: null }
        : { data: {}, error: new Error("Invalid local demo credentials") };
    },
    signUp: async ({ email, password, options }) => {
      const user = {
        id: crypto.randomUUID(),
        email: email.toLowerCase(),
        password,
      };
      users[user.email] = user;
      state.profiles.push({
        id: user.id,
        full_name: options?.data?.full_name || "Local Customer",
        phone: null,
        country: null,
      });
      return { data: { user, session: null }, error: null };
    },
    refreshSession: async () => ({
      data: {},
      error: new Error("Sign in again in local demo mode"),
    }),
    resetPasswordForEmail: async () => ({ data: {}, error: null }),
    verifyOtp: async () => ({
      data: {},
      error: new Error("External email is disabled in local demo mode"),
    }),
  };
  const serviceAuth = {
    getUser: async (token) => ({
      data: { user: sessions.get(token) || null },
      error: null,
    }),
    admin: {
      signOut: async (token) => {
        sessions.delete(token);
        return { error: null };
      },
      updateUserById: async () => ({ data: {}, error: null }),
      inviteUserByEmail: async () => ({
        data: {},
        error: new Error("Invitations are disabled in local demo mode"),
      }),
    },
  };
  const cookieOptions = {
    httpOnly: true,
    secure: false,
    sameSite: "strict",
    path: "/",
  };
  const auth = {
    anon: { auth: authApi },
    service: {
      auth: serviceAuth,
      storage: {
        from: () => ({
          createSignedUploadUrl: async () => ({
            data: null,
            error: new Error("Uploads are disabled in local demo mode"),
          }),
          createSignedUrl: async () => ({
            data: null,
            error: new Error("Evidence is unavailable in local demo mode"),
          }),
        }),
      },
    },
    setSession(res, session, kind = "customer") {
      const prefix = kind === "admin" ? "admin_" : "customer_";
      res.cookie(`${prefix}access_token`, session.access_token, {
        ...cookieOptions,
        maxAge: 3600000,
      });
      res.cookie(`${prefix}refresh_token`, session.refresh_token, {
        ...cookieOptions,
        maxAge: 86400000,
      });
      const csrfToken = crypto.randomBytes(24).toString("base64url");
      res.cookie(`${prefix}csrf`, csrfToken, {
        secure: false,
        sameSite: "strict",
        path: "/",
        maxAge: 86400000,
      });
      return csrfToken;
    },
    clearSession(res, kind = "customer") {
      const prefix = kind === "admin" ? "admin_" : "customer_";
      for (const name of [`${prefix}access_token`, `${prefix}refresh_token`, `${prefix}csrf`])
        res.clearCookie(name, { path: "/" });
    },
    validateAdminNetwork() {},
    async requireUser(req, _res, next) {
      const user = sessions.get(req.cookies.customer_access_token);
      if (!user)
        return next(
          new HttpError(401, "AUTH_REQUIRED", "Authentication required."),
        );
      req.user = user;
      next();
    },
    requireAdmin() {
      return async (req, _res, next) => {
        const user = sessions.get(req.cookies.admin_access_token);
        if (!user || user.email !== "admin@local.demo")
          return next(
            new HttpError(
              403,
              "ADMIN_REQUIRED",
              "Administrator access required.",
            ),
          );
        req.user = user;
        req.admin = {
          id: ids.admin,
          is_super_admin: true,
          status: "active",
          role: "Super Administrator",
          permissions: [],
        };
        next();
      };
    },
  };
  return {
    db,
    services: { auth },
  };
}
