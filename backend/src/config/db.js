// MySQL pool + one-time setup (database, tables from data/schema.sql, seed from data/flights.json).
const fs = require("fs");
const path = require("path");
const mysql = require("mysql2");
const env = require("./env");

let pool = null;

const db = {
  query(...args) {
    if (!pool) throw new Error("Database not initialised yet");
    return pool.query(...args);
  },
  transaction,
  init,
};

const run = (conn, sql, params) =>
  new Promise((resolve, reject) => conn.query(sql, params, (e, rows) => (e ? reject(e) : resolve(rows))));

async function transaction(work) {
  if (!pool) throw new Error("Database not initialised yet");
  const connection = await new Promise((resolve, reject) => {
    pool.getConnection((error, conn) => (error ? reject(error) : resolve(conn)));
  });
  let started = false;
  const tx = {
    query(sql, params = []) {
      return new Promise((resolve, reject) => {
        connection.query(sql, params, (error, rows) => (error ? reject(error) : resolve([rows])));
      });
    },
  };

  try {
    await new Promise((resolve, reject) => connection.beginTransaction((error) => (error ? reject(error) : resolve())));
    started = true;
    const result = await work(tx);
    await new Promise((resolve, reject) => connection.commit((error) => (error ? reject(error) : resolve())));
    return result;
  } catch (error) {
    if (started) {
      await new Promise((resolve) => connection.rollback(() => resolve()));
    }
    throw error;
  } finally {
    connection.release();
  }
}

function rawConnect(port) {
  return new Promise((resolve, reject) => {
    const conn = mysql.createConnection({
      host: env.db.host, user: env.db.user, password: env.db.password, port, connectTimeout: 5000,
    });
    conn.connect((e) => (e ? reject(e) : resolve(conn)));
  });
}

async function init() {
  // 1. find MySQL + create database
  let port = null, lastErr = null;
  for (const p of env.db.ports) {
    try {
      const conn = await rawConnect(p);
      await run(conn, `CREATE DATABASE IF NOT EXISTS \`${env.db.name}\` CHARACTER SET utf8mb4`);
      conn.end();
      port = p;
      break;
    } catch (e) { lastErr = e; }
  }
  if (port === null) {
    throw new Error(
      `Cannot connect to MySQL at ${env.db.host} (tried port ${env.db.ports.join(", ")}): ${lastErr && lastErr.message}\n` +
      `  -> Make sure MySQL/XAMPP is running and DB_USER / DB_PASSWORD / DB_PORT are correct (see .env.example).`
    );
  }

  // 2. pool
  pool = mysql.createPool({
    host: env.db.host, user: env.db.user, password: env.db.password, database: env.db.name, port,
    waitForConnections: true, connectionLimit: 10,
    decimalNumbers: true, // DECIMAL -> number
  });
  const q = (sql, params) => run(pool, sql, params);

  // 3. schema (data/schema.sql)
  const statements = fs.readFileSync(path.join(env.dataDir, "schema.sql"), "utf8")
    .split(/\r?\n/).filter((l) => !l.trim().startsWith("--")).join("\n")
    .split(";").map((s) => s.trim()).filter(Boolean);
  for (const stmt of statements) await q(stmt);

  // 4. upgrade older databases
  const addColumn = async (table, column, def) => {
    if ((await q(`SHOW COLUMNS FROM \`${table}\` LIKE ?`, [column])).length === 0) {
      await q(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${def}`);
      console.log(`Migrated: added ${table}.${column}`);
    }
  };
  await addColumn("flights", "duration", "VARCHAR(20) NOT NULL DEFAULT '1h 15m'");
  await addColumn("bookings", "created_at", "TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP");
  await addColumn("bookings", "booking_reference", "VARCHAR(40) NULL");
  await addColumn("bookings", "passenger_name", "VARCHAR(100) NULL");
  await addColumn("bookings", "passenger_phone", "VARCHAR(30) NULL");
  await addColumn("bookings", "passenger_age", "SMALLINT NULL");
  await addColumn("bookings", "amount", "DECIMAL(10,2) NOT NULL DEFAULT 0");
  await addColumn("bookings", "currency", "CHAR(3) NOT NULL DEFAULT 'NPR'");
  await addColumn("bookings", "status", "VARCHAR(30) NOT NULL DEFAULT 'LEGACY'");
  await addColumn("bookings", "updated_at", "TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP");

  const bookingColumns = await q("SHOW COLUMNS FROM bookings");
  const bookingColumnNames = new Set(bookingColumns.map((column) => column.Field));
  if (bookingColumnNames.has("card_holder")) {
    await q("UPDATE bookings SET passenger_name = card_holder WHERE passenger_name IS NULL");
  }
  await q("UPDATE bookings b JOIN flights f ON f.id = b.flight_id SET b.amount = f.price WHERE b.amount = 0");
  await q("UPDATE bookings SET booking_reference = CONCAT('AN-LEGACY-', LPAD(id, 8, '0')) WHERE booking_reference IS NULL");
  if (bookingColumnNames.has("card_number")) await q("ALTER TABLE bookings DROP COLUMN card_number");
  if (bookingColumnNames.has("card_holder")) await q("ALTER TABLE bookings DROP COLUMN card_holder");
  if (bookingColumnNames.has("expiry")) await q("ALTER TABLE bookings DROP COLUMN expiry");
  const bookingIndexes = await q("SHOW INDEX FROM bookings WHERE Key_name = 'uq_bookings_reference'");
  if (bookingIndexes.length === 0) {
    await q("ALTER TABLE bookings ADD UNIQUE KEY uq_bookings_reference (booking_reference)");
  }
  await addColumn("payments", "callback_signature_valid", "BOOLEAN NOT NULL DEFAULT FALSE");
  await addColumn("user", "role", "VARCHAR(10) NOT NULL DEFAULT 'user'");

  // 5. seed data (data/flights.json) on first run
  const [{ n }] = await q("SELECT COUNT(*) AS n FROM flights");
  if (n === 0) {
    const flights = JSON.parse(fs.readFileSync(path.join(env.dataDir, "flights.json"), "utf8"));
    await q(
      "INSERT INTO flights (flight_name, source, destination, departure_time, price, duration) VALUES ?",
      [flights.map((f) => [f.flight_name, f.source, f.destination, f.departure_time, f.price, f.duration])]
    );
    console.log(`Seeded ${flights.length} sample flights from data/flights.json`);
  }

  console.log(`Database connected (${env.db.host}:${port}/${env.db.name})`);
}

module.exports = db;
