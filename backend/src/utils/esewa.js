const crypto = require("crypto");

const SIGNED_REQUEST_FIELDS = "total_amount,transaction_uuid,product_code";
const REQUIRED_RESPONSE_FIELDS = [
  "transaction_code",
  "status",
  "total_amount",
  "transaction_uuid",
  "product_code",
  "signed_field_names",
];

function createSignature(fields, signedFieldNames, secretKey) {
  const message = signedFieldNames
    .split(",")
    .map((name) => `${name}=${fields[name]}`)
    .join(",");
  return crypto.createHmac("sha256", secretKey).update(message).digest("base64");
}

function verifyResponseSignature(response, secretKey) {
  if (!response || typeof response !== "object" || typeof response.signed_field_names !== "string") return false;
  const signedNames = response.signed_field_names.split(",");
  if (new Set(signedNames).size !== signedNames.length) return false;
  if (REQUIRED_RESPONSE_FIELDS.some((name) => !signedNames.includes(name))) return false;
  if (signedNames.some((name) => !/^[a-z_]+$/.test(name) || response[name] === undefined || response[name] === null)) return false;
  if (REQUIRED_RESPONSE_FIELDS.some((name) => String(response[name]).length === 0)) return false;
  if (typeof response.signature !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(response.signature)) return false;

  const expected = Buffer.from(createSignature(response, response.signed_field_names, secretKey), "base64");
  const actual = Buffer.from(response.signature, "base64");
  if (actual.toString("base64") !== response.signature) return false;
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function decodeResponse(encoded) {
  if (typeof encoded !== "string" || encoded.length > 8192 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return null;
  try {
    const buffer = Buffer.from(encoded, "base64");
    if (buffer.toString("base64") !== encoded) return null;
    const decoded = buffer.toString("utf8");
    const response = JSON.parse(decoded);
    return response && typeof response === "object" && !Array.isArray(response) ? response : null;
  } catch {
    return null;
  }
}

function toMinorUnits(value) {
  if (typeof value !== "number" && typeof value !== "string") return null;
  const text = String(value);
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) return null;
  const amount = Number(text);
  if (!Number.isFinite(amount)) return null;
  return Math.round(amount * 100);
}

function formatAmount(value) {
  const minorUnits = toMinorUnits(value);
  if (minorUnits === null) throw new Error("Invalid payment amount.");
  return (minorUnits / 100).toFixed(2);
}

module.exports = {
  SIGNED_REQUEST_FIELDS,
  createSignature,
  decodeResponse,
  formatAmount,
  toMinorUnits,
  verifyResponseSignature,
};
