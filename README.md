# AeroNepal domestic flight booking

AeroNepal now searches and books only Nepal-to-Nepal schedules. Airport selection is restricted to the IATA-code allowlist in `backend/data/domestic-registry.js`; routes cannot use codes outside that Nepal registry. Airports such as Kathmandu (KTM) that also handle international traffic are permitted only as endpoints of routes whose two airports are in Nepal. The list is the application's configured registry, not a guarantee that it is a complete current CAAN/IATA directory; confirm airport names and identifiers with authoritative sources before production. CAAN's AIP portal did not expose its directory content during this integration.

## Live flight status and booking inventory

The home page's primary search requests matching bookable demo schedules from the backend and informational flight-status data from Aviationstack. The browser never receives the provider key. Live results are displayed only if Aviationstack returns matching records for the requested date and active domestic route; missing coverage and provider errors never fall back to demo data. No Aviationstack response is treated as a fare, seat count, or booking authorization.

Nepal route coverage has **not been verified**: it requires a provider account/key and a successful test response for each route. The public [Aviationstack documentation](https://aviationstack.com/documentation) describes the Flight API but does not publish a route-by-route Nepal coverage guarantee, and the documentation page is client-rendered. On October 12, 2026, the [pricing page](https://aviationstack.com/pricing) listed a Free plan with 100 requests, real-time flights, HTTPS, and non-commercial use; its Basic plan listed 10,000 monthly requests and future-flight schedules. Plan features and quotas can change. The Free real-time plan may not provide future-date schedules; empty results are reported as unknown coverage, not proof that no service exists. Check the account's live plan limits before deployment.

The dashboard search shows matching bookable admin-managed demo schedules separately from live flight status. Demo records remain available for the existing application booking/eSewa UAT workflow, are visibly labeled as demo, and are never represented as actual airline tickets or live availability. This application does not scrape airline sites.

The supported airline registry lists Buddha Air (U4), Yeti Airlines (YT), Shree Airlines (N9), and Nepal Airlines (RA). Their inclusion is not a claim that any airline serves an entered route or schedule. The initial domestic route allowlist includes KTM-PKR, KTM-BIR, KTM-KEP, KTM-BHR, and PKR-JMO so those example searches can be tested; these route entries do not claim that a carrier currently operates them. Admin-created schedule records are demo entries, and real airline availability or booking authorization is not established by them.

Before updating airport metadata/codes, verify current aerodrome information in the [Civil Aviation Authority of Nepal (CAAN) Aeronautical Information Publication portal](https://e-aip.caanepal.gov.np/) and verify IATA location identifiers against an authoritative IATA source. CAAN's [official site](https://caanepal.gov.np/) is the regulator reference. Do not treat this application or its demo database as an aviation-data provider.

## Setup

Requirements: Node.js 18 or newer and a running MySQL server (the existing setup tries ports 3306 and 3307 unless `DB_PORT` is set). The in-memory test adapter uses the built-in `node:sqlite` module and therefore requires Node.js 22 or newer to run the tests.

```powershell
Set-Location backend
npm ci
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
```

Edit `backend/.env` and set the database credentials, a unique `JWT_SECRET`, and `AVIATIONSTACK_API_KEY` for live flight data; this setup command preserves an existing `.env`. Set the eSewa UAT values only if testing demo payments. Start the service:

```powershell
npm run dev
```

The backend serves the frontend at `http://localhost:5000`. If you serve the `frontend` directory separately on port 8080, its existing API configuration targets `http://localhost:5000`.

The account registered using `ADMIN_EMAIL` receives the admin role. Configure that email before registering the first admin account.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `DB_HOST`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`, `DB_PORT` | MySQL connection. `DB_PORT` is optional; without it, ports 3306 and 3307 are tried. |
| `PORT` | Backend HTTP port (default `5000`). |
| `JWT_SECRET` | Secret for signed login tokens. Replace the development default with a long random value. |
| `ADMIN_EMAIL` | Email that receives the admin role on registration (default `sagarmishra761271@gmail.com`). |
| `AVIATIONSTACK_API_KEY` | Optional server-only Aviationstack key. Live search returns a clear configuration error when blank. Never place this key in frontend code. |
| `PAYMENT_MODE` | `mock` for the localhost-only fake gateway; `sandbox` to redirect to eSewa UAT (default). |
| `ESEWA_ENVIRONMENT` | Must be `uat` for the existing UAT-only payment integration. |
| `ESEWA_PRODUCT_CODE`, `ESEWA_SECRET_KEY` | eSewa UAT merchant configuration. Keep the secret in `backend/.env`; never commit merchant credentials. This app currently supports UAT only. |
| `ESEWA_FORM_URL`, `ESEWA_STATUS_URL` | ePay V2 form and UAT transaction-status endpoints; defaults target eSewa's official UAT servers. |
| `BASE_URL`, `APP_BASE_URL`, `API_BASE_URL` | App return and backend callback URLs. `BASE_URL` configures the standalone demo flow; use a reachable HTTPS tunnel for remote UAT callbacks. |

Payments are not initialized if eSewa UAT is not configured. The browser submits the signed ePay V2 form to `https://rc-epay.esewa.com.np/api/epay/main/v2/form`; AeroNepal does not collect eSewa passwords, PINs, or OTPs. A booking is confirmed only after validating eSewa's signed callback and matching the transaction UUID, merchant product code, and amount against the official UAT status endpoint, `https://rc.esewa.com.np/api/epay/transaction/status/`. eSewa's hosted UAT login may independently be unavailable when its reCAPTCHA Enterprise quota is exceeded; only eSewa can restore that provider-side service.

### Standalone local payment demo

The normal flight-booking checkout uses a localhost-only fake gateway when `PAYMENT_MODE=mock`, exercising the existing booking reservations and payment result flow without contacting eSewa or charging a customer. `/checkout.html` also provides a separate lightweight payment-only demo. Set `PAYMENT_MODE=sandbox` to submit to eSewa's UAT form URL and verify callbacks against its UAT status endpoint. Mock gateway status is held in memory and resets when the server restarts. Both modes require an `ESEWA_SECRET_KEY` in `backend/.env`; the frontend never receives it.

The requested eSewa documentation vector `total_amount=100,transaction_uuid=11-201-13,product_code=EPAYTEST` produces `5DZywcrTKD0gia/rsSMcrRHmJl+4Tbol6S+lWgdJ94E=` with the stated UAT key and HMAC-SHA256. The `4Ov7pCI1zIOdwtV2BRMUNjz1upIlT/COTxfLhWvVurE=` value shown adjacent to it in the docs does not match that exact input. The test also verifies eSewa's separate form sample (`110`, `241028`) against its documented `i94z...` signature. The implementation uses the HMAC output, not a hardcoded expected signature.

In mock mode, the fake gateway is a local simulation: it never asks for an eSewa ID, password, PIN, CAPTCHA, or token. A demo-only confirmation dialog completes the simulated payment; **Cancel (Failure)** exercises the failure flow. The mock endpoints refuse non-local network requests. To use the real sandbox instead, set `PAYMENT_MODE=sandbox`, confirm the UAT product code and server-side key, and use a public HTTPS tunnel as `BASE_URL` if eSewa must reach the callback. eSewa's own hosted login and CAPTCHA remain controlled by eSewa.

## Database schema and migrations

`backend/data/schema.sql` creates the current schema. On startup, `backend/src/config/db.js` applies additive migrations for existing databases, seeds the restricted airport and airline registries plus the example route allowlist, and creates the required search/idempotency indexes. It does not seed schedules, fares, or seats. Route seeding uses insert-if-absent so administrator deactivation persists across restarts.

Previously stored legacy flight rows are retained for their existing booking-history references but have no domestic route/date and therefore cannot appear in search or be booked. Review and back up the database before deploying schema changes to a production database.

Bookings reserve seats while eSewa is pending. A verified payment converts reserved seats to booked seats; a verified failed/cancelled payment releases the reservation. Unresolved pending payments continue holding their seats until eSewa reports a terminal state, which favors avoiding overbooking over displaying those seats as available.

## APIs

Public endpoints:

- `GET /airports` — active Nepal airport registry.
- `GET /api/airports/domestic` — active airport registry for the live-search UI.
- `GET /api/flights/live?origin=KTM&destination=PKR&date=YYYY-MM-DD&passengers=1` — provider data for an active domestic route only. Has a two-minute in-process cache and a 30-request-per-minute per-client limit. Response includes `source: "AVIATIONSTACK"`, checked time, and provider-supplied flight/status/timing fields only.
- `GET /routes` — active domestic routes.
- `GET /flights/upcoming?passengers=1` — up to 12 upcoming admin-managed demo schedules with enough available seats; shown on the homepage separately from live flight status.
- `GET /flights?origin=KTM&destination=PKR&date=YYYY-MM-DD&passengers=1` — dated schedules with sufficient inventory, NPR fares, and `data_source: "ADMIN_DEMO"`.
- `GET /flights/:id` — schedule details for checkout.
- `POST /book` — requires authentication, an `Idempotency-Key` header, passenger details, a schedule ID, and passenger count. The backend rechecks route, date, fare, and seats in a transaction.
- `/payments/*` — existing eSewa UAT initialization, callback, verification, and retry endpoints.

Admin endpoints (Bearer token with admin role):

- `/admin/domestic/airports` — inspect the supported registry and enable/disable entries. Airport codes and names cannot be free-formed.
- `/admin/domestic/routes` — create, activate/deactivate, and delete routes between active Nepal airports.
- `/admin/domestic/airlines` — inspect the supported airline registry.
- `/admin/domestic/schedules` — create, edit, and delete date-specific demo schedules, NPR fares, and seat capacity.

Fares are stored in NPR with at most two decimal places and are capped at NPR 10,000,000 per passenger so a nine-passenger checkout fits the payment amount column. Checkout totals are calculated using integer minor units.

The retired `POST /add-flight` endpoint returns `410 Gone`; schedule creation must use the validated domestic admin API.

## Verify provider coverage

1. Create an Aviationstack account, review its current plan, and set `AVIATIONSTACK_API_KEY` in `backend/.env`; restart the backend after editing it.
2. The example routes in the registry are inserted as active route allowlist entries on backend startup. Sign in as an admin to deactivate them or create additional domestic route pairs. Only enabled routes whose endpoints are in `backend/data/domestic-registry.js` are accepted.
3. Use today's date first for the plan's real-time flight data. From PowerShell, query the backend (replace the route as needed):

   ```powershell
   $today = Get-Date -Format 'yyyy-MM-dd'
   Invoke-RestMethod "http://localhost:5000/api/flights/live?origin=KTM&destination=PKR&date=$today&passengers=1"
   ```

4. Repeat for KTM-BIR, KTM-KEP, KTM-BHR, and PKR-JMO only after enabling each route. Record a route as covered only when the response contains correctly matching provider-returned flights. A `200` with an empty `flights` array means the provider returned no matching data for that request; it does not establish that the route is not operated. `503` means no key is configured or the provider request quota was exhausted; `502`/`504` indicate provider failure/timeout. Never convert these responses into fabricated flights.
5. Test future dates only after confirming that the account plan includes the provider's future-schedule feature. Flight status data still is not inventory and must not be used to promise seats or fares.

The per-process rate limiter and cache are intended for this single-process app deployment. Use a shared rate-limit/cache service (and enforce edge limits) before running multiple production instances.

## Tests

The backend integration suite uses an in-memory SQLite adapter and does not require a running MySQL server or real eSewa account:

```powershell
Set-Location backend
npm test
npm run test:mock-payments
```

`npm test` covers domestic airport/route restrictions, mocked live-provider responses/errors/rate limiting, schedule search, admin schedule management, fare calculation by passenger count, seat holds and release, overbooking protection, checkout idempotency, and eSewa signature/status verification. `npm run test:mock-payments` checks the standalone mock flow, including invalid amounts and signatures, successful verification, duplicate callbacks, cancellation, and retry blocking. Provider tests use synthetic fixtures; they do not verify actual Nepal route coverage.
