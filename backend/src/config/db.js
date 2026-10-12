// MySQL pool + one-time setup (database, schema migrations, verified registry seed).
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
    dateStrings: true,
  });
  const q = (sql, params) => run(pool, sql, params);

  const existingAirlineTable = await q("SHOW TABLES LIKE 'domestic_airlines'");
  if (existingAirlineTable.length > 0 &&
      (await q("SHOW COLUMNS FROM domestic_airlines LIKE 'id'")).length === 0) {
    await q("ALTER TABLE domestic_airlines ADD COLUMN id INT NOT NULL AUTO_INCREMENT UNIQUE FIRST");
    console.log("Migrated: added domestic_airlines.id");
  }

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
  await addColumn("flights", "route_id", "INT NULL");
  await addColumn("flights", "airline_id", "INT NULL");
  await addColumn("flights", "flight_date", "DATE NULL");
  await addColumn("flights", "arrival_time", "TIME NULL");
  await addColumn("flights", "seat_capacity", "SMALLINT UNSIGNED NOT NULL DEFAULT 0");
  await addColumn("flights", "seats_reserved", "SMALLINT UNSIGNED NOT NULL DEFAULT 0");
  await addColumn("flights", "seats_booked", "SMALLINT UNSIGNED NOT NULL DEFAULT 0");
  await addColumn("flights", "inventory_source", "VARCHAR(30) NOT NULL DEFAULT 'ADMIN_DEMO'");
  await addColumn("bookings", "passenger_count", "SMALLINT UNSIGNED NOT NULL DEFAULT 1");
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
  await addColumn("payments", "idempotency_key", "VARCHAR(100) NULL");
  await addColumn("user", "role", "VARCHAR(10) NOT NULL DEFAULT 'user'");
  const flightSearchIndex = await q("SHOW INDEX FROM flights WHERE Key_name = 'ix_flights_search'");
  if (flightSearchIndex.length === 0) {
    await q("ALTER TABLE flights ADD INDEX ix_flights_search (flight_date, route_id, airline_id)");
  }
  const flightUniqueIndex = await q("SHOW INDEX FROM flights WHERE Key_name = 'uq_flights_schedule'");
  if (flightUniqueIndex.length === 0) {
    await q("ALTER TABLE flights ADD UNIQUE KEY uq_flights_schedule (route_id, airline_id, flight_date, departure_time, flight_name)");
  }
  const paymentIdempotencyIndex = await q("SHOW INDEX FROM payments WHERE Key_name = 'uq_payments_idempotency_key'");
  if (paymentIdempotencyIndex.length === 0) {
    await q("ALTER TABLE payments ADD UNIQUE KEY uq_payments_idempotency_key (idempotency_key)");
  }
  const addForeignKey = async (table, constraint, statement) => {
    const [row] = await q(
      "SELECT COUNT(*) AS count FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND CONSTRAINT_NAME = ?",
      [env.db.name, table, constraint]
    );
    if (Number(row.count) === 0) await q(statement);
  };
  await addForeignKey("flights", "fk_flights_domestic_route",
    "ALTER TABLE flights ADD CONSTRAINT fk_flights_domestic_route FOREIGN KEY (route_id) REFERENCES domestic_routes(id) ON DELETE RESTRICT");
  await addForeignKey("flights", "fk_flights_domestic_airline",
    "ALTER TABLE flights ADD CONSTRAINT fk_flights_domestic_airline FOREIGN KEY (airline_id) REFERENCES domestic_airlines(id) ON DELETE RESTRICT");

  // Airport and carrier metadata is a restricted registry, not a source of schedules or fares.
  const { airports, airlines, domesticRoutes } = require("../../data/domestic-registry");
  for (const airport of airports) {
    await q(
      "INSERT INTO domestic_airports (iata, name, city, province) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE name=VALUES(name), city=VALUES(city), province=VALUES(province)",
      [airport.iata, airport.name, airport.city, airport.province]
    );
  }
  for (const route of domesticRoutes) {
    await q(
      "INSERT IGNORE INTO domestic_routes (origin_iata, destination_iata, active) VALUES (?, ?, TRUE)",
      [route.origin_iata, route.destination_iata]
    );
  }
  for (const airline of airlines) {
    await q(
      "INSERT INTO domestic_airlines (iata, name) VALUES (?, ?) ON DUPLICATE KEY UPDATE name=VALUES(name)",
      [airline.iata, airline.name]
    );
  }

  console.log(`Database connected (${env.db.host}:${port}/${env.db.name})`);
}

module.exports = db;
