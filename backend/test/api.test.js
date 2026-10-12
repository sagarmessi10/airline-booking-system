// End-to-end API test. Uses an in-memory SQLite database that mimics the mysql2 query()
// interface, so it runs without a MySQL server:  npm test
const path = require("path");
const assert = require("assert");
const { DatabaseSync } = require("node:sqlite");
const jwt = require("jsonwebtoken");
const env = require("../src/config/env");
const { createSignature } = require("../src/utils/esewa");

env.esewa.secretKey = "unit-test-only-secret";

const sqlite = new DatabaseSync(":memory:");
sqlite.exec("PRAGMA foreign_keys = ON");
sqlite.exec(`
  CREATE TABLE user (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, password TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user');
  CREATE TABLE flights (id INTEGER PRIMARY KEY AUTOINCREMENT, flight_name TEXT NOT NULL, source TEXT NOT NULL, destination TEXT NOT NULL, departure_time TEXT, price REAL NOT NULL, duration TEXT NOT NULL DEFAULT '1h 15m');
  CREATE TABLE bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    flight_id INT NOT NULL REFERENCES flights(id) ON DELETE CASCADE,
    booking_reference TEXT NOT NULL UNIQUE,
    passenger_name TEXT NOT NULL,
    passenger_phone TEXT NOT NULL,
    passenger_age INT NOT NULL,
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
  INSERT INTO flights (flight_name, source, destination, departure_time, price) VALUES ('AN101','Kathmandu','Pokhara','07:30 AM',6500);
`);

const fakeDb = {
  init: async () => {},
  async transaction(work) {
    sqlite.exec("BEGIN");
    const tx = {
      async query(sql, params = []) {
        const compatibleSql = sql.replace(/\s+FOR UPDATE\s*$/i, "");
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
      const stmt = sqlite.prepare(sql);
      if (/^\s*select/i.test(sql)) return cb(null, stmt.all(...params));
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
  const httpFetch = global.fetch.bind(global);
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
  r = await call("POST", "/register", { name: "Admin", email: "admin@gmail.com", password: "admin123" });
  t("admin email gets admin role", r.status === 201 && r.body.user.role === "admin");
  const adminToken = r.body.token;

  r = await call("POST", "/login", { email: "alice@gmail.com", password: "wrong" }); t("wrong password -> 401", r.status === 401);
  r = await call("POST", "/login", { email: "nobody@gmail.com", password: "x" }); t("unknown user -> 401", r.status === 401);
  r = await call("POST", "/login", { email: "ram@123.com", password: "x" }); t("login rejects non-Gmail address", r.status === 400);
  r = await call("POST", "/login", { email: "alice@gmail.com", password: "secret1" }); t("login works", r.status === 200 && !!r.body.token);
  r = await call("GET", "/me", null, userToken); t("/me with token", r.body.user.email === "alice@gmail.com");
  r = await call("GET", "/me"); t("/me without token -> 401", r.status === 401);
  r = await call("GET", "/me", null, "garbage"); t("/me bad token -> 403", r.status === 403);

  r = await call("GET", "/flights"); t("list flights", r.status === 200 && r.body.length === 1);

  r = await call("POST", "/add-flight", { flight_name: "X", source: "A", destination: "B", price: 100 }); t("add-flight needs login", r.status === 401);
  r = await call("POST", "/add-flight", { flight_name: "X", source: "A", destination: "B", price: 100 }, userToken); t("add-flight blocks non-admin", r.status === 403);
  r = await call("POST", "/add-flight", { flight_name: "X", source: "A", destination: "B", price: -5 }, adminToken); t("add-flight validates price", r.status === 400);
  r = await call("POST", "/add-flight", { flight_name: "AN202", source: "Kathmandu", destination: "Lukla", departure_time: "06:00 AM", price: "12500" }, adminToken);
  t("admin adds flight", r.status === 201); const newFlightId = r.body.id;
  r = await call("GET", "/flights"); t("flight list now 2", r.body.length === 2 && r.body[1].duration === "1h 15m");

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
  r = await call("POST", "/book", { ...passenger, flight_id: 999 }, userToken); t("book unknown flight -> 404", r.status === 404);
  r = await call("POST", "/book", { ...passenger, amount: 1, total_amount: 1 }, userToken);
  t("booking creates pending eSewa payment", r.status === 201 && r.body.message === "Payment initialized." &&
    r.body.fields.product_code === "EPAYTEST" && r.body.fields.total_amount === "6500.00" &&
    r.body.formUrl === "https://rc-epay.esewa.com.np/api/epay/main/v2/form");
  t("payment request is server-signed and does not expose the UAT key",
    r.body.fields.signature === createSignature(r.body.fields, "total_amount,transaction_uuid,product_code", env.esewa.secretKey) &&
    !JSON.stringify(r.body).includes(env.esewa.secretKey));
  const bookingId = r.body.booking_id;
  const transactionUuid = r.body.fields.transaction_uuid;
  const storedBooking = sqlite.prepare("SELECT * FROM bookings WHERE id = ?").get(bookingId);
  const storedPayment = sqlite.prepare("SELECT * FROM payments WHERE booking_id = ?").get(bookingId);
  t("booking and payment begin pending with trusted database fare",
    storedBooking.status === "PENDING" && storedBooking.amount === 6500 &&
    storedPayment.status === "PENDING" && storedPayment.amount === 6500 &&
    storedPayment.provider === "esewa" && storedPayment.transaction_uuid === transactionUuid);
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
      assert.ok(String(url).startsWith("https://uat.esewa.com.np/api/epay/transaction/status/"));
      return {
        ok: true,
        json: async () => ({
          status,
          scd: "EPAYTEST",
          totalAmount: 6500,
          pid: "UAT-PID-001",
          refId: "UAT-REF-001",
          ...overrides,
        }),
      };
    };
  };
  const callbackUrl = (uuid, data, route = "success") =>
    `/payments/esewa/${route}/${encodeURIComponent(uuid)}${data ? `?data=${encodeURIComponent(data)}` : ""}`;
  const statusBeforePayment = global.fetch;
  setEsewaStatus("COMPLETE");
  let callback = await call("GET", callbackUrl(transactionUuid, signedResponse(transactionUuid, 6500)));
  t("signed success response plus COMPLETE status confirms booking",
    callback.status === 303 && /result=success/.test(callback.location) &&
    sqlite.prepare("SELECT status FROM payments WHERE booking_id = ?").get(bookingId).status === "PAID" &&
    sqlite.prepare("SELECT status FROM bookings WHERE id = ?").get(bookingId).status === "CONFIRMED");
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
  setEsewaStatus("COMPLETE", { totalAmount: 6501 });
  callback = await call("GET", callbackUrl(secondUuid, signedResponse(secondUuid, 6500)));
  t("mismatched official verification amount cannot confirm booking", callback.status === 303 &&
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
  paymentDetails = await call("GET", `/payments/${bookingId}`, null, adminToken);
  t("payment status is restricted to booking owner", paymentDetails.status === 404);
  global.fetch = statusBeforePayment;

  r = await call("GET", "/my-bookings", null, userToken); t("my-bookings returns all owner bookings", r.body.length === 8 && r.body[0].flight_name === "AN101");
  r = await call("GET", "/my-bookings", null, adminToken); t("bookings are per-user", r.body.length === 0);

  r = await call("GET", "/admin/stats", null, userToken); t("stats blocks non-admin", r.status === 403);
  r = await call("GET", "/admin/stats", null, adminToken); t("admin stats", r.body.totalUsers === 2 && r.body.totalFlights === 2 && r.body.totalBookings === 8);
  r = await call("GET", "/admin/users", null, adminToken); t("admin users list", r.body.length === 2 && !("password" in r.body[0]));
  r = await call("GET", "/admin/bookings", null, adminToken); t("admin bookings list", r.body[0].user_email === "alice@gmail.com" && r.body[0].payment_status);

  const aliceId = (await call("GET", "/admin/users", null, adminToken)).body.find(u => u.email === "alice@gmail.com").id;
  const adminId = (await call("GET", "/admin/users", null, adminToken)).body.find(u => u.email === "admin@gmail.com").id;
  r = await call("PUT", `/admin/users/${aliceId}/role`, { role: "superuser" }, adminToken); t("role validation", r.status === 400);
  r = await call("PUT", `/admin/users/${adminId}/role`, { role: "user" }, adminToken); t("admin cannot demote self", r.status === 400);
  r = await call("PUT", `/admin/users/9999/role`, { role: "admin" }, adminToken); t("role update unknown user -> 404", r.status === 404);
  r = await call("PUT", `/admin/users/${aliceId}/role`, { role: "admin" }, adminToken); t("promote user", r.status === 200);

  r = await call("PUT", `/admin/flights/${newFlightId}`, { flight_name: "AN202b", source: "Kathmandu", destination: "Lukla", departure_time: "06:30 AM", duration: "35m", price: 13000 }, adminToken);
  t("update flight", r.status === 200);
  r = await call("PUT", `/admin/flights/9999`, { flight_name: "x", source: "a", destination: "b", price: 1 }, adminToken); t("update unknown flight -> 404", r.status === 404);
  r = await call("DELETE", `/admin/flights/${newFlightId}`, null, userToken); t("delete flight blocks non-admin token", r.status === 403);
  r = await call("DELETE", `/admin/flights/${newFlightId}`, null, adminToken); t("admin deletes flight", r.status === 200);
  r = await call("DELETE", `/admin/flights/${newFlightId}`, null, adminToken); t("delete missing flight -> 404", r.status === 404);
  r = await call("DELETE", `/admin/flights/1`, null, adminToken); t("deleting flight cascades its bookings", r.status === 200 && sqlite.prepare("SELECT COUNT(*) c FROM bookings").get().c === 0);
  r = await call("DELETE", `/admin/flights/abc`, null, adminToken); t("bad id -> 400", r.status === 400);

  r = await call("GET", "/nope"); t("unknown route -> 404 JSON", r.status === 404 && r.body.message);
  const raw = await fetch(base + "/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{bad" });
  t("malformed JSON -> 400", raw.status === 400);

  console.log(`\nAll ${passed} checks passed.`);
  server.close(); process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
