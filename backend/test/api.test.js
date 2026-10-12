// End-to-end API test. Uses an in-memory SQLite database that mimics the mysql2 query()
// interface, so it runs without a MySQL server:  npm test
const path = require("path");
const assert = require("assert");
const { DatabaseSync } = require("node:sqlite");

const sqlite = new DatabaseSync(":memory:");
sqlite.exec("PRAGMA foreign_keys = ON");
sqlite.exec(`
  CREATE TABLE user (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, password TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user');
  CREATE TABLE flights (id INTEGER PRIMARY KEY AUTOINCREMENT, flight_name TEXT NOT NULL, source TEXT NOT NULL, destination TEXT NOT NULL, departure_time TEXT, price REAL NOT NULL, duration TEXT NOT NULL DEFAULT '1h 15m');
  CREATE TABLE bookings (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INT NOT NULL REFERENCES user(id) ON DELETE CASCADE, flight_id INT NOT NULL REFERENCES flights(id) ON DELETE CASCADE, card_number TEXT, card_holder TEXT, expiry TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
  INSERT INTO flights (flight_name, source, destination, departure_time, price) VALUES ('AN101','Kathmandu','Pokhara','07:30 AM',6500);
`);

const fakeDb = {
  init: async () => {},
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
  const call = async (method, url, body, token) => {
    const res = await fetch(base + url, {
      method,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, contentType: res.headers.get("content-type"), body: json };
  };
  let passed = 0;
  const t = (name, cond) => { assert.ok(cond, "FAILED: " + name); console.log("  ✔", name); passed++; };

  let r = await call("GET", "/");
  t("root serves the frontend", r.status === 200 && /text\/html/.test(r.contentType));
  r = await call("GET", "/health"); t("health ok", r.body.status === "ok");

  r = await call("POST", "/register", { name: "A", email: "bad", password: "123456" }); t("rejects bad email", r.status === 400);
  r = await call("POST", "/register", { name: "A", email: "a@x.com", password: "123" }); t("rejects short password", r.status === 400);
  r = await call("POST", "/register", { name: "Alice", email: "Alice@X.com", password: "secret1" });
  t("register user", r.status === 201 && r.body.user.role === "user" && r.body.user.email === "alice@x.com");
  const userToken = r.body.token;
  r = await call("POST", "/register", { name: "Alice", email: "alice@x.com", password: "secret1" }); t("duplicate email -> 409", r.status === 409);
  r = await call("POST", "/register", { name: "Admin", email: "admin@gmail.com", password: "admin123" });
  t("admin email gets admin role", r.status === 201 && r.body.user.role === "admin");
  const adminToken = r.body.token;

  r = await call("POST", "/login", { email: "alice@x.com", password: "wrong" }); t("wrong password -> 401", r.status === 401);
  r = await call("POST", "/login", { email: "nobody@x.com", password: "x" }); t("unknown user -> 401", r.status === 401);
  r = await call("POST", "/login", { email: "alice@x.com", password: "secret1" }); t("login works", r.status === 200 && !!r.body.token);
  r = await call("GET", "/me", null, userToken); t("/me with token", r.body.user.email === "alice@x.com");
  r = await call("GET", "/me"); t("/me without token -> 401", r.status === 401);
  r = await call("GET", "/me", null, "garbage"); t("/me bad token -> 403", r.status === 403);

  r = await call("GET", "/flights"); t("list flights", r.status === 200 && r.body.length === 1);

  r = await call("POST", "/add-flight", { flight_name: "X", source: "A", destination: "B", price: 100 }); t("add-flight needs login", r.status === 401);
  r = await call("POST", "/add-flight", { flight_name: "X", source: "A", destination: "B", price: 100 }, userToken); t("add-flight blocks non-admin", r.status === 403);
  r = await call("POST", "/add-flight", { flight_name: "X", source: "A", destination: "B", price: -5 }, adminToken); t("add-flight validates price", r.status === 400);
  r = await call("POST", "/add-flight", { flight_name: "AN202", source: "Kathmandu", destination: "Lukla", departure_time: "06:00 AM", price: "12500" }, adminToken);
  t("admin adds flight", r.status === 201); const newFlightId = r.body.id;
  r = await call("GET", "/flights"); t("flight list now 2", r.body.length === 2 && r.body[1].duration === "1h 15m");

  const card = { flight_id: 1, card_number: "4111 1111 1111 1234", card_holder: "Alice", expiry: "12/30" };
  r = await call("POST", "/book", card); t("book needs login", r.status === 401);
  r = await call("POST", "/book", { ...card, card_number: "123" }, userToken); t("book rejects bad card", r.status === 400);
  r = await call("POST", "/book", { ...card, flight_id: 999 }, userToken); t("book unknown flight -> 404", r.status === 404);
  r = await call("POST", "/book", card, userToken); t("booking succeeds", r.status === 200 && r.body.message === "Booking Successful");
  const stored = sqlite.prepare("SELECT card_number FROM bookings").get().card_number;
  t("only last 4 card digits stored", stored === "**** **** **** 1234" && !stored.includes("4111"));

  r = await call("GET", "/my-bookings", null, userToken); t("my-bookings returns booking", r.body.length === 1 && r.body[0].flight_name === "AN101");
  r = await call("GET", "/my-bookings", null, adminToken); t("bookings are per-user", r.body.length === 0);

  r = await call("GET", "/admin/stats", null, userToken); t("stats blocks non-admin", r.status === 403);
  r = await call("GET", "/admin/stats", null, adminToken); t("admin stats", r.body.totalUsers === 2 && r.body.totalFlights === 2 && r.body.totalBookings === 1);
  r = await call("GET", "/admin/users", null, adminToken); t("admin users list", r.body.length === 2 && !("password" in r.body[0]));
  r = await call("GET", "/admin/bookings", null, adminToken); t("admin bookings list", r.body[0].user_email === "alice@x.com");

  const aliceId = (await call("GET", "/admin/users", null, adminToken)).body.find(u => u.email === "alice@x.com").id;
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
