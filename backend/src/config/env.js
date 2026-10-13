// Loads backend/.env (if present) and exposes all settings in one place.
const fs = require("fs");
const path = require("path");

const envFile = path.join(__dirname, "..", "..", ".env");
if (fs.existsSync(envFile)) {
  fs.readFileSync(envFile, "utf8").split(/\r?\n/).forEach((line) => {
    const m = line.match(/^\s*([\w.]+)\s*=\s*(.*?)\s*$/);
    if (m && !line.trim().startsWith("#") && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  });
}

module.exports = {
  port: Number(process.env.PORT) || 5000,
  jwtSecret: process.env.JWT_SECRET || "aeronepal_secret_key_2026",
  adminEmail: (process.env.ADMIN_EMAIL || "sagarmishra761271@gmail.com").toLowerCase(),
  db: {
    host: process.env.DB_HOST || "127.0.0.1",
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASSWORD || "",
    name: process.env.DB_NAME || "airline_db",
    // unset -> try 3306 then 3307
    ports: process.env.DB_PORT ? [Number(process.env.DB_PORT)] : [3306, 3307],
  },
  esewa: {
    environment: (process.env.ESEWA_ENVIRONMENT || "uat").toLowerCase(),
    productCode: process.env.ESEWA_PRODUCT_CODE || "EPAYTEST",
    secretKey: process.env.ESEWA_SECRET_KEY || "",
    formUrl: process.env.ESEWA_FORM_URL || "https://rc-epay.esewa.com.np/api/epay/main/v2/form",
    statusUrl: process.env.ESEWA_STATUS_URL || "https://rc.esewa.com.np/api/epay/transaction/status/",
  },
  paymentMode: (process.env.PAYMENT_MODE || "sandbox").toLowerCase(),
  aviationstack: {
    apiKey: process.env.AVIATIONSTACK_API_KEY || "",
  },
  appBaseUrl: (process.env.BASE_URL || process.env.APP_BASE_URL || `http://localhost:${Number(process.env.PORT) || 5000}`).replace(/\/+$/, ""),
  apiBaseUrl: (process.env.API_BASE_URL || `http://localhost:${Number(process.env.PORT) || 5000}`).replace(/\/+$/, ""),
  dataDir: path.join(__dirname, "..", "..", "data"),
};
