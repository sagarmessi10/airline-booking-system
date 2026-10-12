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
  init,
};

const run = (conn, sql, params) =>
  new Promise((resolve, reject) => conn.query(sql, params, (e, rows) => (e ? reject(e) : resolve(rows))));

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
