// End-to-end API test. Uses an in-memory SQLite database that mimics the mysql2 query()
// interface, so it runs without a MySQL server:  npm test
const path = require("path");
const assert = require("assert");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const jwt = require("jsonwebtoken");
const env = require("../src/config/env");
const { createSignature, multiplyAmount } = require("../src/utils/esewa");

env.esewa.secretKey = "unit-test-only-secret";
env.paymentMode = "sandbox";

const sqlite = new DatabaseSync(":memory:");
sqlite.exec("PRAGMA foreign_keys = ON");
sqlite.exec(`
  CREATE TABLE domestic_airports (iata TEXT PRIMARY KEY, name TEXT NOT NULL, city TEXT NOT NULL, province TEXT NOT NULL, active INT NOT NULL DEFAULT 1);
  CREATE TABLE domestic_airlines (id INTEGER PRIMARY KEY AUTOINCREMENT, iata TEXT NOT NULL UNIQUE, name TEXT NOT NULL, active INT NOT NULL DEFAULT 1);
  CREATE TABLE domestic_routes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    origin_iata TEXT NOT NULL REFERENCES domestic_airports(iata),
    destination_iata TEXT NOT NULL REFERENCES domestic_airports(iata),
    active INT NOT NULL DEFAULT 1,
    UNIQUE(origin_iata, destination_iata)
  );
  CREATE TABLE user (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, password TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user');
  CREATE TABLE flights (
    id INTEGER PRIMARY KEY AUTOINCREMENT, flight_name TEXT NOT NULL, source TEXT NOT NULL,
    destination TEXT NOT NULL, departure_time TEXT, price REAL NOT NULL, duration TEXT NOT NULL DEFAULT '1h 15m',
    route_id INT REFERENCES domestic_routes(id), airline_id INT REFERENCES domestic_airlines(id),
    flight_date TEXT, arrival_time TEXT, seat_capacity INT NOT NULL DEFAULT 0,
    seats_reserved INT NOT NULL DEFAULT 0, seats_booked INT NOT NULL DEFAULT 0,
    inventory_source TEXT NOT NULL DEFAULT 'ADMIN_DEMO'
  );
  CREATE TABLE bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    flight_id INT NOT NULL REFERENCES flights(id) ON DELETE CASCADE,
    booking_reference TEXT NOT NULL UNIQUE,
    passenger_name TEXT NOT NULL,
    passenger_phone TEXT NOT NULL,
    passenger_age INT NOT NULL,
    passenger_count INT NOT NULL DEFAULT 1,
    amount NUMERIC NOT NULL,
    currency TEXT NOT NULL DEFAULT 'NPR',
    status TEXT NOT NULL DEFAULT 'PENDING',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    booking_id INT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
    transaction_uuid TEXT NOT NULL UNIQUE,
    idempotency_key TEXT UNIQUE,
    provider TEXT NOT NULL,
    amount NUMERIC NOT NULL,
    currency TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING',
    provider_reference TEXT,
    verification_result TEXT NOT NULL DEFAULT 'AWAITING_PAYMENT',
    callback_signature_valid INT NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    verified_at TEXT
  );
  INSERT INTO domestic_airports VALUES
    ('KTM', 'Tribhuvan International Airport', 'Kathmandu', 'Bagmati', 1),
    ('PKR', 'Pokhara International Airport', 'Pokhara', 'Gandaki', 1),
    ('BIR', 'Biratnagar Airport', 'Biratnagar', 'Koshi', 1),
    ('KEP', 'Nepalgunj Airport', 'Nepalgunj', 'Lumbini', 1),
    ('BHR', 'Bharatpur Airport', 'Bharatpur', 'Bagmati', 1),
    ('JMO', 'Jomsom Airport', 'Jomsom', 'Gandaki', 1),
    ('LUA', 'Tenzing-Hillary Airport', 'Lukla', 'Koshi', 1);
  INSERT INTO domestic_airlines (iata, name) VALUES ('U4', 'Buddha Air'), ('YT', 'Yeti Airlines');
  INSERT INTO domestic_routes (origin_iata, destination_iata) VALUES
    ('KTM', 'PKR'), ('KTM', 'LUA'), ('KTM', 'BIR'), ('KTM', 'KEP'), ('KTM', 'BHR'), ('PKR', 'JMO');
  INSERT INTO flights
    (flight_name, source, destination, departure_time, price, route_id, airline_id, flight_date, seat_capacity)
    VALUES ('BA101','KTM','PKR','07:30',6500,1,1,'2099-06-01',50);
`);

const fakeDb = {
  init: async () => {},
  async transaction(work) {
    sqlite.exec("BEGIN");
    const tx = {
      async query(sql, params = []) {
        const compatibleSql = sql.replace(/\s+FOR UPDATE\s*$/i, "").replace(/CURDATE\(\)/gi, "date('now')");
        const stmt = sqlite.prepare(compatibleSql);
        if (/^\s*select/i.test(compatibleSql)) return [stmt.all(...params)];
        const result = stmt.run(...params);
        return [{
          insertId: Number(result.lastInsertRowid),
          affectedRows: Number(result.changes),
        }];
      },
    };
    try {
      const result = await work(tx);
      sqlite.exec("COMMIT");
      return result;
    } catch (error) {
      sqlite.exec("ROLLBACK");
      throw error;
    }
  },
  query(sql, params, cb) {
    if (typeof params === "function") { cb = params; params = []; }
    try {
      const compatibleSql = sql.replace(/\s+FOR UPDATE\s*$/i, "").replace(/CURDATE\(\)/gi, "date('now')");
      const stmt = sqlite.prepare(compatibleSql);
      if (/^\s*select/i.test(compatibleSql)) return cb(null, stmt.all(...params));
      const r = stmt.run(...params);
      cb(null, { insertId: Number(r.lastInsertRowid), affectedRows: Number(r.changes) });
    } catch (e) {
      if (/UNIQUE/.test(e.message)) e.code = "ER_DUP_ENTRY";
      cb(e);
    }
  },
};
require.cache[require.resolve("../src/config/db")] = { id: "db", filename: "db", loaded: true, exports: fakeDb };

const app = require("../src/app");

(async () => {
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  env.apiBaseUrl = base;
  const nativeFetch = global.fetch.bind(global);
  let requestIdempotencyKey = null;
  const httpFetch = (url, options = {}) => {
    const headers = new Headers(options.headers);
    if (new URL(url).pathname === "/book") {
      headers.set("Idempotency-Key", requestIdempotencyKey || crypto.randomUUID());
    }
    return nativeFetch(url, { ...options, headers });
  };
  const call = async (method, url, body, token) => {
    const res = await httpFetch(base + url, {
      method,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      redirect: "manual",
    });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, contentType: res.headers.get("content-type"), location: res.headers.get("location"), body: json };
  };
  let passed = 0;
  const t = (name, cond) => { assert.ok(cond, "FAILED: " + name); console.log("  ✔", name); passed++; };
  t("eSewa UAT request signature matches the documented sample",
    createSignature(
      { total_amount: "110", transaction_uuid: "241028", product_code: "EPAYTEST" },
      "total_amount,transaction_uuid,product_code",
      "8gBm/:&EnhH.1/q"
    ) === "i94zsd3oXF6ZsSr/kGqT4sSzYQzjj1W/waxjWyRwaME=");
  t("NPR fare multiplication uses exact minor units", multiplyAmount("0.10", 3) === "0.30");

  let r = await call("GET", "/");
  t("root serves the frontend", r.status === 200 && /text\/html/.test(r.contentType));
  r = await call("GET", "/payment-result.html");
  t("payment result page is served by existing frontend", r.status === 200 && /text\/html/.test(r.contentType));
  r = await call("GET", "/health"); t("health ok", r.body.status === "ok");

  r = await call("POST", "/register", { name: "A", email: "bad", password: "123456" }); t("rejects bad email", r.status === 400);
  r = await call("POST", "/register", { name: "A", email: "ram@123.com", password: "123456" }); t("rejects non-Gmail address", r.status === 400);
  r = await call("POST", "/register", { name: "A", email: "a@x.com", password: "123" }); t("rejects short password", r.status === 400);
  r = await call("POST", "/register", { name: "Alice", email: "Alice@gmail.com", password: "secret1" });
  t("register Gmail user", r.status === 201 && r.body.user.role === "user" && r.body.user.email === "alice@gmail.com");
  const userToken = r.body.token;
  r = await call("POST", "/register", { name: "Alice", email: "alice@gmail.com", password: "secret1" }); t("duplicate email -> 409", r.status === 409);
  r = await call("POST", "/register", { name: "Admin", email: env.adminEmail, password: "admin123" });
  t("admin email gets admin role", r.status === 201 && r.body.user.role === "admin");
  const adminToken = r.body.token;

  r = await call("POST", "/login", { email: "alice@gmail.com", password: "wrong" }); t("wrong password -> 401", r.status === 401);
  r = await call("POST", "/login", { email: "nobody@gmail.com", password: "x" }); t("unknown user -> 401", r.status === 401);
  r = await call("POST", "/login", { email: "ram@123.com", password: "x" }); t("login rejects non-Gmail address", r.status === 400);
  r = await call("POST", "/login", { email: "alice@gmail.com", password: "secret1" }); t("login works", r.status === 200 && !!r.body.token);
  r = await call("GET", "/me", null, userToken); t("/me with token", r.body.user.email === "alice@gmail.com");
  r = await call("GET", "/me"); t("/me without token -> 401", r.status === 401);
  r = await call("GET", "/me", null, "garbage"); t("/me bad token -> 403", r.status === 403);

  r = await call("GET", "/airports");
  t("public airport list is restricted to Nepal IATA registry", r.status === 200 && r.body.some((airport) => airport.iata === "KTM"));
  r = await call("GET", "/flights");
  t("search requires route, date, and passenger count", r.status === 400);
  r = await call("GET", "/flights?origin=KTM&destination=PKR&date=2099-06-01&passengers=2");
  t("search returns dynamic dated domestic schedules", r.status === 200 && r.body.length === 1 &&
    r.body[0].source === "KTM" && r.body[0].source_name === "Kathmandu" && r.body[0].data_source === "ADMIN_DEMO");
  r = await call("GET", "/flights?origin=LHR&destination=KTM&date=2099-06-01&passengers=1");
  t("search rejects international airports outside Nepal registry", r.status === 400);
  r = await call("GET", "/flights?origin=KTM&destination=KTM&date=2099-06-01&passengers=1");
  t("search rejects same origin and destination", r.status === 400);

  r = await call("GET", "/api/airports/domestic");
  t("live-search airport API returns the domestic registry", r.status === 200 &&
    ["KTM", "PKR", "BIR", "KEP", "BHR", "JMO"].every((iata) =>
      r.body.some((airport) => airport.iata === iata)));
  const originalFetch = global.fetch;
  const originalAviationstackKey = env.aviationstack.apiKey;
  env.aviationstack.apiKey = "";
  r = await call("GET", "/api/flights/live");
  t("live search validates required parameters", r.status === 400 && r.body.code === "INVALID_SEARCH");
  r = await call("GET", "/api/flights/live?origin=KTM&destination=PKR&date=2099-02-30&passengers=1");
  t("live search rejects impossible dates", r.status === 400 && r.body.code === "INVALID_SEARCH");
  r = await call("GET", "/api/flights/live?origin=KTM&destination=PKR&date=2099-06-01&passengers=10");
  t("live search validates passenger count", r.status === 400 && r.body.code === "INVALID_SEARCH");
  r = await call("GET", "/api/flights/live?origin=LHR&destination=KTM&date=2099-06-01&passengers=1");
  t("live search rejects international airports", r.status === 400 && r.body.code === "INVALID_SEARCH");
  r = await call("GET", "/api/flights/live?origin=PKR&destination=BIR&date=2099-06-01&passengers=1");
  t("live search rejects unsupported domestic airport pairs", r.status === 400 &&
    r.body.code === "UNSUPPORTED_DOMESTIC_ROUTE");
  r = await call("GET", "/api/flights/live?origin=KTM&destination=PKR&date=2099-06-01&passengers=1");
  t("live search reports a missing provider key without returning demo schedules",
    r.status === 503 && r.body.code === "LIVE_PROVIDER_NOT_CONFIGURED");

  env.aviationstack.apiKey = "test-only-aviationstack-key";
  let aviationstackCalls = 0;
  const supportedProviderRouteKeys = new Set([
    ["KTM", "PKR"], ["KTM", "BIR"], ["KTM", "KEP"], ["KTM", "BHR"], ["PKR", "JMO"],
  ].map(([origin, destination]) => `${origin}:${destination}`));
  let aviationstackResponse = {
    data: [{
      flight_date: "2099-06-01",
      flight_status: "scheduled",
      departure: {
        iata: "KTM", scheduled: "2099-06-01T07:00:00+00:00",
        estimated: "2099-06-01T07:10:00+00:00", actual: null, delay: 10,
      },
      arrival: {
        iata: "PKR", scheduled: "2099-06-01T07:30:00+00:00",
        estimated: null, actual: null, delay: null,
      },
      airline: { name: "Test Provider Airline" },
      flight: { iata: "TP101", number: "101" },
      live: { updated: "2099-06-01T06:45:00+00:00" },
    }],
  };
  global.fetch = async (url) => {
    aviationstackCalls += 1;
    const providerUrl = new URL(url);
    assert.ok(
      providerUrl.protocol === "https:" && providerUrl.searchParams.get("access_key") === env.aviationstack.apiKey &&
      supportedProviderRouteKeys.has(
        `${providerUrl.searchParams.get("dep_iata")}:${providerUrl.searchParams.get("arr_iata")}`
      ),
      "provider API request must use HTTPS, the backend-only key, and a tested domestic route"
    );
    return { ok: true, status: 200, json: async () => aviationstackResponse };
  };
  r = await call("GET", "/api/flights/live?origin=KTM&destination=PKR&date=2099-06-01&passengers=1");
  t("live search returns only date- and route-matching provider data with timing/status fields",
    r.status === 200 && r.body.source === "AVIATIONSTACK" && r.body.flights.length === 1 &&
    r.body.flights[0].flight_number === "TP101" &&
    r.body.flights[0].departure.estimated === "2099-06-01T07:10:00+00:00" &&
    r.body.flights[0].arrival.scheduled === "2099-06-01T07:30:00+00:00" &&
    r.body.flights[0].flight_status === "scheduled" &&
    !JSON.stringify(r.body).includes(env.aviationstack.apiKey) &&
    !("price" in r.body.flights[0]) && !("seats_available" in r.body.flights[0]));
  const providerCallsAfterSearch = aviationstackCalls;
  r = await call("GET", "/api/flights/live?origin=KTM&destination=PKR&date=2099-06-01&passengers=1");
  t("live flight results are briefly cached", r.status === 200 && aviationstackCalls === providerCallsAfterSearch);

  aviationstackResponse = { data: [] };
  r = await call("GET", "/api/flights/live?origin=KTM&destination=PKR&date=2099-06-02&passengers=1");
  t("empty provider results remain an empty live result", r.status === 200 && r.body.flights.length === 0);
  const exampleRoutes = [
    ["KTM", "BIR"], ["KTM", "KEP"], ["KTM", "BHR"], ["PKR", "JMO"],
  ];
  const exampleRouteResults = [];
  for (const [origin, destination] of exampleRoutes) {
    exampleRouteResults.push(await call(
      "GET",
      `/api/flights/live?origin=${origin}&destination=${destination}&date=2099-06-07&passengers=1`
    ));
  }
  t("example Nepal routes pass domestic allowlisting without fabricating provider flights",
    exampleRouteResults.every((result) => result.status === 200 && result.body.flights.length === 0));
  aviationstackResponse = { error: { code: 104, message: "Rate limit exceeded" } };
  r = await call("GET", "/api/flights/live?origin=KTM&destination=PKR&date=2099-06-03&passengers=1");
  t("provider rate limits are surfaced without demo fallback", r.status === 503 &&
    r.body.code === "LIVE_PROVIDER_RATE_LIMITED");
  global.fetch = async () => {
    const error = new Error("simulated timeout");
    error.name = "AbortError";
    throw error;
  };
  r = await call("GET", "/api/flights/live?origin=KTM&destination=PKR&date=2099-06-04&passengers=1");
  t("provider timeouts return an explicit gateway timeout", r.status === 504 &&
    r.body.code === "LIVE_PROVIDER_TIMEOUT");
  global.fetch = async () => { throw new Error("simulated network failure"); };
  r = await call("GET", "/api/flights/live?origin=KTM&destination=PKR&date=2099-06-05&passengers=1");
  t("provider network failures return an explicit unavailable error", r.status === 502 &&
    r.body.code === "LIVE_PROVIDER_UNAVAILABLE");
  global.fetch = async () => ({
    ok: true, status: 200, json: async () => ({ data: [{ flight_date: "2099-06-06" }] }),
  });
  r = await call("GET", "/api/flights/live?origin=KTM&destination=PKR&date=2099-06-06&passengers=1");
  t("provider data for a different or incomplete route is not exposed", r.status === 200 &&
    r.body.flights.length === 0);
  global.fetch = originalFetch;
  env.aviationstack.apiKey = originalAviationstackKey;

  r = await call("POST", "/add-flight", { flight_name: "X", source: "A", destination: "B", price: 100 }); t("add-flight needs login", r.status === 401);
  r = await call("POST", "/add-flight", { flight_name: "X", source: "A", destination: "B", price: 100 }, userToken); t("add-flight blocks non-admin", r.status === 403);
  r = await call("POST", "/add-flight", { flight_name: "X", source: "A", destination: "B", price: 100 }, adminToken);
  t("legacy flight creation endpoint is retired", r.status === 410);
  r = await call("POST", "/admin/domestic/routes", { origin_iata: "KTM", destination_iata: "LHR" }, adminToken);
  t("admin route creation rejects non-Nepal airport codes", r.status === 400);
  r = await call("POST", "/admin/domestic/schedules", {
    flight_name: "YT202", route_id: 2, airline_id: 2, flight_date: "2099-06-02",
    departure_time: "06:00", price: 12500, duration: "35m", seat_capacity: 12
  }, userToken);
  t("schedule creation blocks non-admin", r.status === 403);
  r = await call("POST", "/admin/domestic/schedules", {
    flight_name: "YT202", route_id: 2, airline_id: 2, flight_date: "2099-06-02",
    departure_time: "06:00", price: -1, duration: "35m", seat_capacity: 12
  }, adminToken);
  t("admin schedule creation validates positive fare", r.status === 400);
  r = await call("POST", "/admin/domestic/schedules", {
    flight_name: "YT202", route_id: 2, airline_id: 2, flight_date: "2099-06-02",
    departure_time: "06:00", price: 10000000.01, duration: "35m", seat_capacity: 12
  }, adminToken);
  t("admin schedule fare fits the maximum booking amount", r.status === 400);
  r = await call("POST", "/admin/domestic/schedules", {
    flight_name: "YT202", route_id: 2, airline_id: 2, flight_date: "2099-06-02",
    departure_time: "06:00", price: 12500, duration: "35m", seat_capacity: 12
  }, adminToken);
  t("admin creates an explicitly demo domestic schedule", r.status === 201);
  const newFlightId = r.body.id;
  r = await call("GET", "/flights/upcoming?passengers=4");
  t("upcoming public schedules include admin-created flights with enough seats",
    r.status === 200 && r.body.some((flight) => flight.id === newFlightId && flight.data_source === "ADMIN_DEMO") &&
    r.body.every((flight) => flight.seats_available >= 4));
  r = await call("GET", "/flights/upcoming?passengers=10");
  t("upcoming schedules validate passenger count", r.status === 400);
  r = await call("POST", "/admin/domestic/schedules", {
    flight_name: "YT203", route_id: 2, airline_id: 2, flight_date: "2099-06-03",
    departure_time: "08:00", price: 0.1, duration: "35m", seat_capacity: 3
  }, adminToken);
  t("admin can configure a fractional NPR fare", r.status === 201);
  const fractionalFareFlightId = r.body.id;
  r = await call("GET", "/flights?origin=KTM&destination=LUA&date=2099-06-02&passengers=1");
  t("admin schedule becomes searchable only for its domestic date and route", r.status === 200 &&
    r.body.length === 1 && r.body[0].data_source === "ADMIN_DEMO" && r.body[0].seats_available === 12);
  r = await call("POST", "/admin/domestic/schedules", {
    flight_name: "U4LOW", route_id: 1, airline_id: 1, flight_date: "2099-06-01",
    departure_time: "08:00", price: 6500, duration: "25m", seat_capacity: 2
  }, adminToken);
  t("admin can create a limited seat-inventory schedule", r.status === 201);
  const lowInventoryFlightId = r.body.id;

  const passenger = { flight_id: 1, passenger_name: "Alice Passenger", passenger_phone: "9800000000", passenger_age: 25 };
  r = await call("POST", "/book", passenger); t("book needs login", r.status === 401);
  const legacyToken = jwt.sign({ id: 999, email: "ram@123.com", role: "user" }, env.jwtSecret);
  r = await call("POST", "/book", passenger, legacyToken); t("book rejects legacy non-Gmail account", r.status === 403);
  r = await call("POST", "/book", { ...passenger, passenger_phone: "9600000000" }, userToken);
  t("book rejects phone number not starting with 98 or 97", r.status === 400 && /start with 98 or 97/.test(r.body.message));
  r = await call("POST", "/book", { ...passenger, passenger_phone: "98 00000000" }, userToken);
  t("book rejects non-digit characters in phone number", r.status === 400);
  r = await call("POST", "/book", { ...passenger, passenger_phone: "980000000" }, userToken);
  t("book rejects phone numbers shorter than 10 digits", r.status === 400);
  r = await call("POST", "/book", { ...passenger, passenger_phone: "9700000000" }, userToken);
  t("book accepts valid 97-prefixed phone number", r.status === 201);
  r = await call("POST", "/book", { ...passenger, passenger_age: 18 }, userToken);
  t("book rejects passengers younger than 19", r.status === 400 && /at least 19/.test(r.body.message));
  r = await call("POST", "/book", { ...passenger, passenger_age: 19 }, userToken);
  t("book accepts passenger age 19", r.status === 201);
  r = await call("POST", "/book", { ...passenger, passenger_count: 10 }, userToken);
  t("booking rejects passenger counts above nine", r.status === 400);
  r = await call("POST", "/book", { ...passenger, flight_id: 999 }, userToken); t("book unknown flight -> 404", r.status === 404);
  const checkoutKey = crypto.randomUUID();
  requestIdempotencyKey = checkoutKey;
  r = await call("POST", "/book", { ...passenger, passenger_count: 2, amount: 1, total_amount: 1 }, userToken);
  t("booking creates pending eSewa payment", r.status === 201 && r.body.message === "Payment initialized." &&
    r.body.fields.product_code === "EPAYTEST" && r.body.fields.total_amount === "13000.00" &&
    r.body.formUrl === "https://rc-epay.esewa.com.np/api/epay/main/v2/form");
  t("payment request is server-signed and does not expose the UAT key",
    r.body.fields.signature === createSignature(r.body.fields, "total_amount,transaction_uuid,product_code", env.esewa.secretKey) &&
    !JSON.stringify(r.body).includes(env.esewa.secretKey));
  const bookingId = r.body.booking_id;
  const transactionUuid = r.body.fields.transaction_uuid;
  t("payment request has required signed fields and merchant callback URLs",
    r.body.fields.signed_field_names === "total_amount,transaction_uuid,product_code" &&
    r.body.fields.success_url === `${env.apiBaseUrl}/payments/esewa/success/${transactionUuid}` &&
    r.body.fields.failure_url === `${env.apiBaseUrl}/payments/esewa/failure/${transactionUuid}`);
  const duplicateCheckout = await call("POST", "/book", { ...passenger, passenger_count: 2 }, userToken);
  requestIdempotencyKey = null;
  t("repeated checkout request returns the same pending payment",
    duplicateCheckout.status === 201 && duplicateCheckout.body.booking_id === bookingId &&
    duplicateCheckout.body.fields.transaction_uuid === transactionUuid &&
    sqlite.prepare("SELECT COUNT(*) count FROM payments WHERE idempotency_key = ?").get(checkoutKey).count === 1);
  const storedBooking = sqlite.prepare("SELECT * FROM bookings WHERE id = ?").get(bookingId);
  const storedPayment = sqlite.prepare("SELECT * FROM payments WHERE booking_id = ?").get(bookingId);
  t("booking and payment begin pending with trusted database fare",
    storedBooking.status === "PENDING" && storedBooking.amount === 13000 && storedBooking.passenger_count === 2 &&
    storedPayment.status === "PENDING" && storedPayment.amount === 13000 &&
    storedPayment.provider === "esewa" && storedPayment.transaction_uuid === transactionUuid);
  t("pending payment atomically reserves requested seats",
    sqlite.prepare("SELECT seats_reserved FROM flights WHERE id = 1").get().seats_reserved === 4);
  t("card information is not present in booking schema",
    !sqlite.prepare("PRAGMA table_info(bookings)").all().some((column) => /card|expiry/i.test(column.name)));

  const signedResponse = (uuid, totalAmount, status = "COMPLETE", signatureSecret = env.esewa.secretKey, productCode = "EPAYTEST") => {
    const response = {
      transaction_code: "TEST-REF-001",
      status,
      total_amount: totalAmount,
      transaction_uuid: uuid,
      product_code: productCode,
      signed_field_names: "transaction_code,status,total_amount,transaction_uuid,product_code,signed_field_names",
    };
    response.signature = createSignature(response, response.signed_field_names, signatureSecret);
    return Buffer.from(JSON.stringify(response)).toString("base64");
  };
  const setEsewaStatus = (status, overrides = {}) => {
    global.fetch = async (url) => {
      const statusUrl = new URL(String(url));
      assert.equal(`${statusUrl.origin}${statusUrl.pathname}`, "https://rc.esewa.com.np/api/epay/transaction/status/");
      assert.equal(statusUrl.searchParams.get("product_code"), "EPAYTEST");
      assert.ok(statusUrl.searchParams.get("total_amount"));
      const statusUuid = statusUrl.searchParams.get("transaction_uuid");
      assert.ok(statusUuid);
      return {
        ok: true,
        json: async () => ({
          status,
          product_code: "EPAYTEST",
          transaction_uuid: statusUuid,
          total_amount: 6500,
          ref_id: "UAT-REF-001",
          ...overrides,
        }),
      };
    };
  };
  const callbackUrl = (uuid, data, route = "success") =>
    `/payments/esewa/${route}/${encodeURIComponent(uuid)}${data ? `?data=${encodeURIComponent(data)}` : ""}`;
  const statusBeforePayment = global.fetch;
  const fractionalFareBooking = await call("POST", "/book", {
    ...passenger, flight_id: fractionalFareFlightId, passenger_count: 3
  }, userToken);
  t("checkout calculates fractional fares exactly for all passengers",
    fractionalFareBooking.status === 201 &&
    fractionalFareBooking.body.fields.total_amount === "0.30" &&
    sqlite.prepare("SELECT amount FROM bookings WHERE id = ?").get(fractionalFareBooking.body.booking_id).amount === 0.3);
  setEsewaStatus("NOT_FOUND", { total_amount: 0.3 });
  const fractionalFareUuid = fractionalFareBooking.body.fields.transaction_uuid;
  await call("GET", callbackUrl(fractionalFareUuid, signedResponse(fractionalFareUuid, "0.30")));
  t("fractional-fare failed payment releases reserved seats",
    sqlite.prepare("SELECT seats_reserved FROM flights WHERE id = ?").get(fractionalFareFlightId).seats_reserved === 0);
  const twoSeatBooking = await call("POST", "/book", { ...passenger, flight_id: lowInventoryFlightId, passenger_count: 2 }, userToken);
  t("booking reserves the full requested seat count", twoSeatBooking.status === 201 &&
    sqlite.prepare("SELECT seats_reserved FROM flights WHERE id = ?").get(lowInventoryFlightId).seats_reserved === 2);
  const overCapacityBooking = await call("POST", "/book", { ...passenger, flight_id: lowInventoryFlightId, passenger_count: 1 }, userToken);
  t("concurrent-style follow-up booking cannot exceed seat capacity", overCapacityBooking.status === 409);
  setEsewaStatus("NOT_FOUND", { total_amount: 13000 });
  const twoSeatUuid = twoSeatBooking.body.fields.transaction_uuid;
  await call("GET", callbackUrl(twoSeatUuid, signedResponse(twoSeatUuid, 13000)));
  t("failed payment releases its reserved seats", sqlite.prepare("SELECT seats_reserved FROM flights WHERE id = ?").get(lowInventoryFlightId).seats_reserved === 0);
  setEsewaStatus("COMPLETE", { total_amount: 13000 });
  let callback = await call("GET", callbackUrl(transactionUuid, signedResponse(transactionUuid, 13000)));
  t("signed success response plus COMPLETE status confirms booking",
    callback.status === 303 && /result=success/.test(callback.location) &&
    sqlite.prepare("SELECT status FROM payments WHERE booking_id = ?").get(bookingId).status === "PAID" &&
    sqlite.prepare("SELECT status FROM bookings WHERE id = ?").get(bookingId).status === "CONFIRMED" &&
    sqlite.prepare("SELECT seats_booked FROM flights WHERE id = 1").get().seats_booked === 2);
  let paymentDetails = await call("GET", `/payments/${bookingId}`, null, userToken);
  t("payment reference is returned only after verification",
    paymentDetails.status === 200 && paymentDetails.body.provider_reference === "UAT-REF-001" &&
    paymentDetails.body.payment_status === "PAID" && paymentDetails.body.booking_reference === r.body.booking_reference);
  callback = await call("GET", callbackUrl(transactionUuid, signedResponse(transactionUuid, 6500)));
  t("duplicate callback is idempotent", callback.status === 303 &&
    sqlite.prepare("SELECT COUNT(*) count FROM payments WHERE status = 'PAID'").get().count === 1);
  paymentDetails = await call("GET", `/payments/${bookingId}`, null, userToken);
  t("refreshing payment status preserves verified confirmation", paymentDetails.body.payment_status === "PAID");
  global.fetch = statusBeforePayment;

  const secondBooking = await call("POST", "/book", passenger, userToken);
  const secondBookingId = secondBooking.body.booking_id;
  const secondUuid = secondBooking.body.fields.transaction_uuid;
  callback = await call("GET", callbackUrl(secondUuid, signedResponse(secondUuid, 6500, "COMPLETE", "wrong-secret")));
  t("invalid callback signature cannot confirm booking", callback.status === 303 &&
    sqlite.prepare("SELECT status FROM payments WHERE transaction_uuid = ?").get(secondUuid).status === "PENDING" &&
    sqlite.prepare("SELECT status FROM bookings WHERE id = ?").get(secondBookingId).status === "PENDING");
  setEsewaStatus("COMPLETE");
  callback = await call("GET", callbackUrl(secondUuid, signedResponse(secondUuid, 6499)));
  t("incorrect callback amount cannot confirm booking", callback.status === 303 &&
    sqlite.prepare("SELECT status FROM payments WHERE transaction_uuid = ?").get(secondUuid).status === "PENDING");
  callback = await call("GET", callbackUrl(secondUuid, signedResponse("wrong-uuid", 6500)));
  t("incorrect callback transaction UUID cannot confirm booking", callback.status === 303 &&
    sqlite.prepare("SELECT status FROM bookings WHERE id = ?").get(secondBookingId).status === "PENDING");
  callback = await call("GET", callbackUrl(secondUuid, signedResponse(secondUuid, 6500, "COMPLETE", env.esewa.secretKey, "WRONG-CODE")));
  t("incorrect merchant product code cannot confirm booking", callback.status === 303 &&
    sqlite.prepare("SELECT status FROM bookings WHERE id = ?").get(secondBookingId).status === "PENDING");
  setEsewaStatus("COMPLETE", { total_amount: 6501 });
  callback = await call("GET", callbackUrl(secondUuid, signedResponse(secondUuid, 6500)));
  t("mismatched official verification amount cannot confirm booking", callback.status === 303 &&
    sqlite.prepare("SELECT status FROM bookings WHERE id = ?").get(secondBookingId).status === "PENDING");
  setEsewaStatus("COMPLETE", { transaction_uuid: "different-transaction" });
  callback = await call("GET", callbackUrl(secondUuid, signedResponse(secondUuid, 6500)));
  t("mismatched official verification transaction UUID cannot confirm booking", callback.status === 303 &&
    sqlite.prepare("SELECT status FROM bookings WHERE id = ?").get(secondBookingId).status === "PENDING");

  const pendingBooking = await call("POST", "/book", passenger, userToken);
  const pendingBookingId = pendingBooking.body.booking_id;
  const pendingUuid = pendingBooking.body.fields.transaction_uuid;
  setEsewaStatus("PENDING");
  callback = await call("GET", callbackUrl(pendingUuid, signedResponse(pendingUuid, 6500, "PENDING")));
  t("pending transaction is not confirmed",
    callback.status === 303 && sqlite.prepare("SELECT status FROM bookings WHERE id = ?").get(pendingBookingId).status === "PENDING");
  setEsewaStatus("COMPLETE");
  await call("POST", `/payments/${pendingBookingId}/verify`, null, userToken);
  t("COMPLETE status without a signed successful response remains unpaid",
    sqlite.prepare("SELECT status FROM bookings WHERE id = ?").get(pendingBookingId).status === "PENDING");

  const timeoutBooking = await call("POST", "/book", passenger, userToken);
  const timeoutBookingId = timeoutBooking.body.booking_id;
  const timeoutUuid = timeoutBooking.body.fields.transaction_uuid;
  global.fetch = async () => {
    const error = new Error("request timed out");
    error.name = "AbortError";
    throw error;
  };
  callback = await call("GET", callbackUrl(timeoutUuid, signedResponse(timeoutUuid, 6500)));
  t("verification timeout leaves payment pending",
    callback.status === 303 && sqlite.prepare("SELECT status FROM bookings WHERE id = ?").get(timeoutBookingId).status === "PENDING");
  setEsewaStatus("COMPLETE");
  await call("POST", `/payments/${timeoutBookingId}/verify`, null, userToken);
  t("timeout can be re-verified using persisted signed response validation",
    sqlite.prepare("SELECT status FROM bookings WHERE id = ?").get(timeoutBookingId).status === "CONFIRMED");

  const failedBooking = await call("POST", "/book", passenger, userToken);
  const failedBookingId = failedBooking.body.booking_id;
  const failedUuid = failedBooking.body.fields.transaction_uuid;
  setEsewaStatus("NOT_FOUND");
  callback = await call("GET", callbackUrl(failedUuid, signedResponse(failedUuid, 6500)));
  t("NOT_FOUND payment becomes failed and unconfirmed",
    callback.status === 303 && sqlite.prepare("SELECT status FROM bookings WHERE id = ?").get(failedBookingId).status === "PAYMENT_FAILED");
  const retry = await call("POST", `/payments/${failedBookingId}/retry`, null, userToken);
  t("failed payment retry creates a fresh transaction UUID",
    retry.status === 200 && retry.body.fields.transaction_uuid !== failedUuid &&
    sqlite.prepare("SELECT status FROM bookings WHERE id = ?").get(failedBookingId).status === "PENDING");
  const retryAgain = await call("POST", `/payments/${failedBookingId}/retry`, null, userToken);
  t("retry cannot be duplicated while the new attempt is pending", retryAgain.status === 409);

  const cancelledBooking = await call("POST", "/book", passenger, userToken);
  const cancelledId = cancelledBooking.body.booking_id;
  const cancelledUuid = cancelledBooking.body.fields.transaction_uuid;
  setEsewaStatus("CANCELED");
  callback = await call("GET", callbackUrl(cancelledUuid, null, "failure"));
  t("cancellation is recorded as failed and not paid",
    callback.status === 303 && /result=cancelled/.test(callback.location) &&
    sqlite.prepare("SELECT status FROM bookings WHERE id = ?").get(cancelledId).status === "PAYMENT_FAILED");

  env.paymentMode = "mock";
  const localMockBooking = await call("POST", "/book", passenger, userToken);
  const localMockId = localMockBooking.body.booking_id;
  const localMockUuid = localMockBooking.body.fields.transaction_uuid;
  t("normal flight checkout routes to the local mock instead of eSewa UAT",
    localMockBooking.status === 201 &&
    localMockBooking.body.formUrl === `${base}/payments/mock-esewa/form`);
  let mockGateway = await httpFetch(base + "/payments/mock-esewa/form", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(localMockBooking.body.fields),
  });
  const mockGatewayHtml = await mockGateway.text();
  t("normal booking shows a credential-free local mock confirmation dialog",
    mockGateway.status === 200 &&
    /LOCAL MOCK — NO REAL PAYMENT/.test(mockGatewayHtml) &&
    /<dialog[^>]*id="demo-dialog"/.test(mockGatewayHtml) &&
    !/name="(?:esewa_id|password|mpin|token)"/.test(mockGatewayHtml));
  mockGateway = await httpFetch(base + "/payments/mock-esewa/complete", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      transaction_uuid: localMockUuid,
      demo_confirmation: "approved",
    }),
    redirect: "manual",
  });
  const mockCallbackUrl = new URL(mockGateway.headers.get("location"));
  callback = await call("GET", mockCallbackUrl.pathname + mockCallbackUrl.search);
  t("local mock response verifies existing booking and confirms seats",
    mockGateway.status === 303 && callback.status === 303 &&
    sqlite.prepare("SELECT status FROM payments WHERE transaction_uuid = ?").get(localMockUuid).status === "PAID" &&
    sqlite.prepare("SELECT status FROM bookings WHERE id = ?").get(localMockId).status === "CONFIRMED");
  env.paymentMode = "sandbox";

  paymentDetails = await call("GET", `/payments/${bookingId}`, null, adminToken);
  t("payment status is restricted to booking owner", paymentDetails.status === 404);
  global.fetch = statusBeforePayment;

  r = await call("GET", "/my-bookings", null, userToken); t("my-bookings returns all owner bookings", r.body.length === 11 && r.body[0].flight_name === "BA101");
  r = await call("GET", "/my-bookings", null, adminToken); t("bookings are per-user", r.body.length === 0);

  r = await call("GET", "/admin/stats", null, userToken); t("stats blocks non-admin", r.status === 403);
  r = await call("GET", "/admin/stats", null, adminToken); t("admin stats", r.body.totalUsers === 2 && r.body.totalFlights === 4 && r.body.totalBookings === 11);
  r = await call("GET", "/admin/users", null, adminToken); t("admin users list", r.body.length === 2 && !("password" in r.body[0]));
  r = await call("GET", "/admin/bookings", null, adminToken); t("admin bookings list", r.body[0].user_email === "alice@gmail.com" && r.body[0].payment_status);

  const aliceId = (await call("GET", "/admin/users", null, adminToken)).body.find(u => u.email === "alice@gmail.com").id;
  const adminId = (await call("GET", "/admin/users", null, adminToken)).body.find(u => u.email === env.adminEmail).id;
  r = await call("PUT", `/admin/users/${aliceId}/role`, { role: "superuser" }, adminToken); t("role validation", r.status === 400);
  r = await call("PUT", `/admin/users/${adminId}/role`, { role: "user" }, adminToken); t("admin cannot demote self", r.status === 400);
  r = await call("PUT", `/admin/users/9999/role`, { role: "admin" }, adminToken); t("role update unknown user -> 404", r.status === 404);
  r = await call("PUT", `/admin/users/${aliceId}/role`, { role: "admin" }, adminToken); t("promote user", r.status === 200);

  r = await call("PUT", `/admin/domestic/schedules/${newFlightId}`, {
    flight_name: "YT202B", route_id: 2, airline_id: 2, flight_date: "2099-06-02",
    departure_time: "06:30", duration: "35m", price: 13000, seat_capacity: 15
  }, adminToken);
  t("admin can update domestic schedule, fare, and seat capacity", r.status === 200);
  r = await call("PUT", `/admin/domestic/schedules/9999`, {
    flight_name: "YT202B", route_id: 2, airline_id: 2, flight_date: "2099-06-02",
    departure_time: "06:30", duration: "35m", price: 13000, seat_capacity: 15
  }, adminToken);
  t("update unknown schedule -> 404", r.status === 404);
  r = await call("DELETE", `/admin/domestic/schedules/${newFlightId}`, null, userToken);
  t("schedule deletion blocks non-admin token", r.status === 403);
  r = await call("DELETE", `/admin/domestic/schedules/${newFlightId}`, null, adminToken);
  t("admin deletes a schedule without bookings", r.status === 200);
  r = await call("DELETE", `/admin/domestic/schedules/1`, null, adminToken);
  t("schedule with booking records cannot be deleted", r.status === 409 &&
    sqlite.prepare("SELECT COUNT(*) c FROM bookings").get().c === 11);
  r = await call("DELETE", `/admin/domestic/schedules/abc`, null, adminToken); t("bad schedule id -> 400", r.status === 400);

  r = await call("PATCH", "/admin/domestic/airports/LUA", { active: false }, adminToken);
  t("deactivating an airport also deactivates its routes",
    r.status === 200 && sqlite.prepare("SELECT active FROM domestic_routes WHERE id = 2").get().active === 0);
  r = await call("PATCH", "/admin/domestic/routes/2", { active: true }, adminToken);
  t("route cannot be enabled while one airport is inactive", r.status === 409);

  r = await call("GET", "/nope"); t("unknown route -> 404 JSON", r.status === 404 && r.body.message);
  const raw = await fetch(base + "/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{bad" });
  t("malformed JSON -> 400", raw.status === 400);

  env.aviationstack.apiKey = "test-only-aviationstack-key";
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ data: [] }) });
  let limitedResponse;
  for (let attempt = 0; attempt < 35; attempt += 1) {
    limitedResponse = await call(
      "GET",
      "/api/flights/live?origin=KTM&destination=PKR&date=2099-06-01&passengers=1"
    );
    if (limitedResponse.status === 429) break;
  }
  t("live search enforces its per-client request limit", limitedResponse.status === 429 &&
    limitedResponse.body.code === "LIVE_SEARCH_RATE_LIMITED");
  global.fetch = originalFetch;
  env.aviationstack.apiKey = originalAviationstackKey;

  console.log(`\nAll ${passed} checks passed.`);
  server.close(); process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
