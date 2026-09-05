# Live Events platform

Black-and-red responsive public ticket-ordering, membership and services site with a separately protected administration dashboard. This phase accepts pending order requests and verifies payment; it deliberately stops before ticket fulfilment.

## Structure

- `index.html`, `style.css`, `script.js` — public UI and API client
- `admin.html`, `admin.css`, `admin.js` — private admin UI and API client
- `server/` — Express application, security middleware, Supabase Auth integration, PostgreSQL access, routes and payment adapters
- `server/routes/` — versioned auth, public and admin endpoints mounted below `/api/v1`
- `server/payments/manual.js` — manual-review boundary used by every payment method
- `supabase/migrations/` — schema, constraints, RLS and hold-expiry function
- `supabase/seed.sql` — fictional development event/roles only
- `test/` — automated security, validation, order and static-boundary tests
- `admin-manifest.json`, `admin-sw.js`, `admin-offline.html`, `assets/admin-icons/` — admin PWA

## Local setup

Requirements: Node.js 20+, npm, and the hosted Supabase values in an ignored `.env` file. The application never creates fallback members, events, orders, credentials, or in-memory demo records.

### Connected development

```powershell
npm install
Copy-Item .env.example .env
# Edit .env locally; never commit it.
npm run migrate
npm run seed
npm start
```

Run the command from the repository root (`c:\Users\tolua\Desktop\website`). This single Express server serves both frontends: open `http://localhost:3000/` for the public/customer site and `http://localhost:3000/admin-site/` for Admin. The server fails fast if required environment variables are absent or malformed.

## Environment variables

`.env.example` is authoritative. Required values configure the runtime/origins, Supabase PostgreSQL connection, Supabase URL/publishable/secret keys, and a 32+ character cookie secret. Optional groups configure admin country/IP policy, private evidence storage, email and opt-in push notification credentials. No payment-provider API credentials are required. `SUPABASE_SERVICE_ROLE_KEY`, database credentials and the cookie secret are server-only.

## Supabase and database

Apply migrations and validate their expected contents:

```powershell
npx supabase db push
npm run test:migrations
npm run seed
```

For a hosted project configured through the ignored `.env` Session Pooler URL, migrations can instead be applied directly with `npm run migrate`. The runner records migration names and SHA-256 checksums in `public.app_schema_migrations`, applies each new file transactionally, and refuses silently modified migration history.

For a direct PostgreSQL workflow:

```powershell
psql $env:DATABASE_URL -v ON_ERROR_STOP=1 -f supabase/migrations/001_initial_schema.sql
psql $env:DATABASE_URL -v ON_ERROR_STOP=1 -f supabase/migrations/002_storage_and_scheduler.sql
psql $env:DATABASE_URL -v ON_ERROR_STOP=1 -f supabase/migrations/003_payment_workflow.sql
psql $env:DATABASE_URL -v ON_ERROR_STOP=1 -f supabase/migrations/004_manual_offsite_payments.sql
psql $env:DATABASE_URL -v ON_ERROR_STOP=1 -f supabase/migrations/005_payment_expiry_audit.sql
psql $env:DATABASE_URL -v ON_ERROR_STOP=1 -f supabase/seed.sql
```

Enable the optional `pg_cron` extension and schedule `select public.release_expired_order_holds()` every minute plus `select public.expire_memberships()` daily, or invoke both from a trusted scheduled server job. Create the `manual-payment-evidence` Storage bucket as private. Do not add public policies; evidence access uses customer-bound signed upload URLs and short-lived admin-authorised signed read URLs.

## Secure first Super Administrator

1. Disable public admin creation; there is no public admin-create endpoint.
2. Apply migrations and seed the role/permission definitions.
3. Put the intended email and a unique strong password directly in the ignored `.env`.
4. Run `npm run bootstrap:admin`. Supabase Auth is created or verified before the database administrator record is updated.
5. Remove the bootstrap password from long-lived configuration and enrol MFA before production access.
6. Add and verify another Super Administrator before ownership handover.

Migration `006_admin_security_and_recovery.sql` permits multiple Super Administrators for safe ownership handover. Its database trigger prevents disabling, demoting, deleting or soft-deleting the final active Super Administrator.

## API

All JSON routes are under `/api/v1` and return `{ success, data|error, requestId }`.

Public/auth: `GET /health`, `/config`; `POST /auth/register`, `/auth/login`, `/auth/admin/login`, `/auth/refresh`, `/auth/logout`, `/auth/forgot-password`, `/auth/reset-password`, `/auth/verify-email`, `/auth/password-reset-session`; `GET/PATCH /auth/me`; `GET /events`, `/events/:slug`; `POST /orders`, `/membership-applications`, `/service-requests`, `/support-requests`, `/account/payments/:id/evidence-upload`, `/account/payments/:id/manual-submission`, `/account/payments/:id/request-fresh-instructions`; `GET /account/notifications`, `/account/orders`, `/account/payments/:id/instructions`, `/account/membership-applications`, `/account/service-requests`.

Admin: `GET /admin/overview`, `/admin/events`, `/admin/events/:id/sections`, `/admin/orders`, `/admin/payments`, `/admin/payments/:id/evidence`, `/admin/members`, `/admin/membership-applications`, `/admin/service-requests`, `/admin/admins`, `/admin/roles`, `/admin/notifications`, `/admin/settings`, `/admin/audit-logs`; `POST /admin/events`, `/admin/events/:id/status`, `/admin/events/:id/sections`, `/admin/payments/:id/assign-details`, `/admin/payments/:id/confirm`, `/admin/payments/:id/reject`, `/admin/membership-applications/:id/decision`, `/admin/admins/invite`, `/admin/notifications/:id/read`; `PATCH /admin/events/:id`, `/admin/sections/:id/inventory`, `/admin/service-requests/:id`, `/admin/admins/:id/role`, `/admin/settings`; `DELETE /admin/admins/:id`.

Automatic payment capture and webhook routes are intentionally not mounted.

## Payments

### Payment-state workflow

Customers must sign in before checkout so assigned details can be restricted to the order owner. Orders are inserted as `pending_payment` and immediately moved to `awaiting_payment_details`. An authorized administrator enters the transaction-specific method, account name, receiving identifier, exact server-calculated amount and currency, unique customer reference, optional instructions and expiry time. Only the authenticated order owner can retrieve an active assignment.

The customer transfers money outside the website, returns, selects **I have made the payment**, and submits the proof requested for the assigned method. Gift Card payments accept a card image, a code, or both; other manual methods accept an uploaded receipt. That submission moves the order to `pending_verification`; the proof never proves receipt. An authorized administrator must inspect the actual receiving account and deliberately confirm or reject the payment. Confirmation is the only transition to `payment_successful`, where processing stops. Expired details can be replaced on the same order without duplicating checkout.

PayPal, Cash App, Chime, bank transfer and gift card all use this manual off-website workflow. No PayPal or Paystack credentials, hosted checkout, callbacks, webhooks or automatic verification are required or exposed.

Account assignment, customer submission, evidence access, confirmation, rejection, administrator identity, timestamps and status transitions are audited. Sensitive assignment fields are excluded from audit metadata and general payment lists. Receipt malware scanning must mark quarantined evidence `clean` before an administrator can open it.

Checkout totals are recalculated using a locked database inventory row; browser totals are ignored. `Idempotency-Key` is required. Inventory holds do not represent tickets.

Evidence is optional supporting material only. A Finance Manager or Super Administrator must inspect the actual receiving account, click **Confirm Money Received**, accept the explicit warning, verify the exact amount and currency, and enter a reason. The server records administrator, timestamp, reason and verification source, changes the payment to `successful`, changes the order to `payment_successful`, moves held quantity to sold, writes an audit event, and stops. The customer status message is: “Payment successful. Your payment has been confirmed.” Rejection also requires a reason.

## PWA

Visit the HTTPS admin origin, sign in, and use the browser install prompt. The service worker caches only public static shell assets. It bypasses `/admin.html` and all `/api/` calls; therefore auth, customer data, orders, payments and evidence are never cached. Logout returns `Clear-Site-Data` and deletes admin caches. Offline mode never exposes dashboard data or bypasses authentication. Push keys are placeholders only; push is not activated.

## Checks and tests

```powershell
npm run check
npm run lint
npm test
npm run test:migrations
npm run build
npm run audit
```

With hosted Supabase credentials configured and the application running locally, `npm run smoke:hosted` performs a reversible end-to-end check. It creates a random temporary Auth user and non-super-admin assignment, verifies customer/admin sessions and database-backed APIs, then removes its audit rows, admin record, and Auth user.

No payment-provider sandbox or API credentials are required because every payment is handled as an off-website transfer with manual administrator verification.

To run the optional real-schema check after linking a dedicated migrated test project: `$env:TEST_DATABASE_URL='postgresql://...' ; npm test`. Configure Supabase email templates to send `token_hash` and `type=email` or `type=recovery` back to the public HTTPS origin; the frontend exchanges these through the server and stores only HTTP-only session cookies.

## Deployment

1. Provision Supabase in the intended region; apply migrations, private storage bucket and fictional seed only in non-production.
2. Deploy this Node service (not a static-only host), set production secrets in the platform secret manager, set `NODE_ENV=production`, `TRUST_PROXY=true`, and use a pooled Supabase connection string.
3. Map the public domain (for example `example.com`) and private admin subdomain (`admin.example.com`) through the reverse proxy to the service. Set exact HTTPS origins in `PUBLIC_ORIGIN` and `ADMIN_ORIGIN`; no wildcards.
4. Redirect HTTP to HTTPS; use TLS 1.2+, HSTS, secure cookies, CSP/security headers and `X-Robots-Tag: noindex` for admin responses.
5. At the edge, restrict the admin hostname with Cloudflare Access, a VPN, or explicit IP allowlisting. A hidden URL is not access control. Enforce Supabase MFA for admins and configure optional country/IP rules only after testing operator access.
6. Verify the manual payment queue, owner-only instructions, expiry replacement and administrator confirmation workflow against a dedicated test order.
7. Schedule expired-hold release and database backups; alert on repeated logins and payment mismatch errors.
8. Run all commands above in CI, smoke-test both hostnames and the PWA over HTTPS, then deploy immutable assets.

## Secrets, backup and recovery

Rotate the Supabase server key, database password and cookie secret through the hosting secret manager; never paste them into source files. Cookie-secret rotation logs sessions out. Use Supabase point-in-time recovery or daily encrypted backups, test restoration quarterly, retain audit/payment records according to applicable law, and document recovery time/objectives. Before recovery, pause checkout, restore to an isolated project, validate constraints/counts, rotate secrets, and then reopen traffic.

## Separate frontend deployments and administrator security

`public-site/` is the deployable copy of the public frontend. `admin-site/` is the separately deployable Netlify administrator PWA, including its manifest, safe-static-only service worker, offline page, icons, redirects, security headers and Netlify configuration. The root frontend files remain as a working fallback. Build packages are written to ignored `dist/` folders:

```powershell
npm run build:public
npm run build:admin
npm run build
```

The copied sites can be inspected with the normal development server at `http://localhost:3000/public-site/` and `http://localhost:3000/admin-site/`. For Netlify, set the non-secret build variable `ADMIN_API_BASE_URL=https://api.example.com` and use `admin-site/netlify.toml`. Only `dist/admin-site` is published; `.env`, server code, database URLs, cookie secrets and Supabase server keys are never copied. Configure the backend `ADMIN_ORIGIN` to the exact HTTPS administrator origin. Set `ADMIN_CROSS_SITE_COOKIES=true` only for a production HTTPS cross-site deployment; development rejects that option.

Set the following server-only values directly in the ignored `.env` or deployment secret manager. Do not pass passwords or API keys on the command line:

```dotenv
INITIAL_SUPER_ADMIN_EMAIL=aaniebiet95@gmail.com
INITIAL_SUPER_ADMIN_PASSWORD=
BREVO_API_KEY=
BREVO_SENDER_EMAIL=
BREVO_SENDER_NAME=
EMAIL_PROVIDER=brevo
ADMIN_OTP_TTL_MINUTES=10
ADMIN_CROSS_SITE_COOKIES=false
```

After `npm run migrate` and `npm run seed`, enter a unique strong initial password directly in `.env`, run `npm run bootstrap:admin`, and remove the password from long-lived runtime configuration. The idempotent command creates or verifies Supabase Auth before upserting the linked profile and active Super Administrator. It never removes previous administrators.

Multiple administrators support invitations, activation/deactivation, selectable role permissions, masked recovery details, login history and audit history. A non-super administrator cannot grant a permission they do not possess. Removal is a soft delete. The final active Super Administrator is protected at both API and database layers.

Administrator Settings includes current/new/confirm password fields, strong-password checks, current-password reauthentication, Supabase Auth update, global session revocation, audit logging and a security email. Forgot-password recovery accepts the registered phone, always returns a generic lookup response, emails a hashed six-digit OTP through Brevo, masks the destination email, limits attempts/resends/IP/phone/account activity, and issues a single-use reset session. Without Brevo credentials, automated tests use a no-network mock; production email recovery remains unavailable rather than leaking the OTP.

Administrator security endpoints are `POST /api/v1/auth/admin/change-password`, `/api/v1/auth/admin/recovery/request`, `/api/v1/auth/admin/recovery/resend`, `/api/v1/auth/admin/recovery/verify`, and `/api/v1/auth/admin/recovery/reset`. Management endpoints include `GET /api/v1/admin/admins`, `/roles`, `/permissions`, `/login-history`; `POST /api/v1/admin/admins/invite`; `PATCH /api/v1/admin/admins/:id/role`, `/:id/status`, `/:id/recovery`, `/roles/:id/permissions`; and soft-delete `DELETE /api/v1/admin/admins/:id`.

Apply migration 006 with the normal transactional runner (`npm run migrate`). The hosted integration test in `npm test` confirms the recovery table exists when `TEST_DATABASE_URL` is configured.

## Intentionally postponed

No ticket generation, numbers, PDFs, QR codes/verification, delivery/email, activation, download, wallet, final seat allocation, scanning/check-in, duplicate/ownership/fraud checks, transfer/resale/cancellation, resending, refund fulfilment, automatic/complimentary issuance, or other fulfilment exists. No member ticket allocation, early access, discount, member-only ticket offer, or other membership-to-ticket connection exists. Payment success has no fulfilment trigger. Those require a separate specialised phase.
