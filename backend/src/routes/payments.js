const express = require("express");
const crypto = require("crypto");
const db = require("../config/db");
const env = require("../config/env");
const { authenticateToken } = require("../middleware/auth");
const { toId } = require("../utils/validators");
const {
  SIGNED_REQUEST_FIELDS,
  createSignature,
  decodeResponse,
  formatAmount,
  toMinorUnits,
  verifyResponseSignature,
} = require("../utils/esewa");

const router = express.Router();
const UAT_FORM_URL = "https://rc-epay.esewa.com.np/api/epay/main/v2/form";
const UAT_STATUS_URL = "https://uat.esewa.com.np/api/epay/transaction/status/";
const VERIFICATION_TIMEOUT_MS = 10000;

function queryRows(sql, params) {
  return new Promise((resolve, reject) => {
    db.query(sql, params, (error, rows) => (error ? reject(error) : resolve(rows)));
  });
}

function paymentIsConfigured() {
  return env.esewa.environment === "uat" &&
    env.esewa.productCode === "EPAYTEST" &&
    Boolean(env.esewa.secretKey) &&
    Boolean(env.appBaseUrl) &&
    Boolean(env.apiBaseUrl);
}

function createTransactionUuid() {
  return crypto.randomUUID();
}

function createPaymentForm(payment) {
  const amount = formatAmount(payment.amount);
  const fields = {
    amount,
    tax_amount: "0",
    total_amount: amount,
    transaction_uuid: payment.transaction_uuid,
    product_code: env.esewa.productCode,
    product_service_charge: "0",
    product_delivery_charge: "0",
    success_url: `${env.apiBaseUrl}/payments/esewa/success/${encodeURIComponent(payment.transaction_uuid)}`,
    failure_url: `${env.apiBaseUrl}/payments/esewa/failure/${encodeURIComponent(payment.transaction_uuid)}`,
    signed_field_names: SIGNED_REQUEST_FIELDS,
  };
  fields.signature = createSignature(fields, fields.signed_field_names, env.esewa.secretKey);
  return { formUrl: UAT_FORM_URL, fields };
}

function getCallbackPayment(transactionUuid) {
  return new Promise((resolve, reject) => {
    db.query(
      `SELECT p.id AS payment_id, p.booking_id, p.transaction_uuid, p.amount, p.currency, p.status,
              b.user_id, b.booking_reference, b.status AS booking_status
       FROM payments p JOIN bookings b ON b.id = p.booking_id
       WHERE p.transaction_uuid = ? AND p.provider = 'esewa'`,
      [transactionUuid],
      (error, rows) => (error ? reject(error) : resolve(rows[0] || null))
    );
  });
}

function updateVerification(paymentId, result, terminalStatus) {
  return db.transaction(async (tx) => {
    const [payments] = await tx.query("SELECT id, booking_id, status FROM payments WHERE id = ?", [paymentId]);
    const payment = payments[0];
    if (!payment || payment.status === "PAID") return payment;

    if (terminalStatus === "PAID") {
      const [updated] = await tx.query(
        "UPDATE payments SET status = 'PAID', provider_reference = ?, verification_result = ?, verified_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'PENDING'",
        [result.providerReference, result.verificationResult, paymentId]
      );
      if (updated.affectedRows === 1) {
        await tx.query(
          "UPDATE bookings SET status = 'CONFIRMED', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
          [payment.booking_id]
        );
      }
    } else if (terminalStatus === "FAILED") {
      const [updated] = await tx.query(
        "UPDATE payments SET status = 'FAILED', verification_result = ? WHERE id = ? AND status = 'PENDING'",
        [result.verificationResult, paymentId]
      );
      if (updated.affectedRows === 1) {
        await tx.query(
          "UPDATE bookings SET status = 'PAYMENT_FAILED', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status <> 'CONFIRMED'",
          [payment.booking_id]
        );
      }
    } else {
      await tx.query(
        "UPDATE payments SET verification_result = ? WHERE id = ? AND status = 'PENDING'",
        [result.verificationResult, paymentId]
      );
    }
    const [current] = await tx.query("SELECT id, booking_id, status FROM payments WHERE id = ?", [paymentId]);
    return current[0];
  });
}

async function requestTransactionStatus(payment) {
  const url = new URL(UAT_STATUS_URL);
  url.searchParams.set("product_code", env.esewa.productCode);
  url.searchParams.set("total_amount", formatAmount(payment.amount));
  url.searchParams.set("transaction_uuid", payment.transaction_uuid);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), VERIFICATION_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { Accept: "application/json" } });
    if (!response.ok) {
      console.warn("eSewa UAT status service returned a non-success response.");
      return { kind: "unavailable" };
    }
    const body = await response.json();
    if (!body || typeof body.status !== "string") {
      console.warn("eSewa UAT status service returned an invalid response.");
      return { kind: "unavailable" };
    }
    if (body.scd !== env.esewa.productCode || toMinorUnits(body.totalAmount) !== toMinorUnits(payment.amount)) {
      return { kind: "mismatch" };
    }
    return { kind: "status", body };
  } catch (error) {
    if (error.name === "AbortError") return { kind: "timeout" };
    console.warn("eSewa UAT status verification is unavailable.");
    return { kind: "unavailable" };
  } finally {
    clearTimeout(timeout);
  }
}

async function applyVerification(payment, callbackSignatureValid) {
  const verification = await requestTransactionStatus(payment);
  if (verification.kind === "timeout" || verification.kind === "unavailable") {
    const outcome = verification.kind === "timeout" ? "VERIFICATION_TIMEOUT" : "VERIFICATION_UNAVAILABLE";
    await updateVerification(payment.payment_id, { verificationResult: outcome });
    return { outcome: "pending" };
  }
  if (verification.kind === "mismatch") {
    await updateVerification(payment.payment_id, { verificationResult: "STATUS_MISMATCH" });
    return { outcome: "unverified" };
  }

  const status = verification.body.status;
  if (status === "COMPLETE" && callbackSignatureValid) {
    await updateVerification(payment.payment_id, {
      providerReference: verification.body.refId || verification.body.pid || null,
      verificationResult: "VERIFIED_COMPLETE",
    }, "PAID");
    return { outcome: "success" };
  }
  if (status === "NOT_FOUND" || status === "CANCELED") {
    await updateVerification(payment.payment_id, { verificationResult: status }, "FAILED");
    return { outcome: status === "CANCELED" ? "cancelled" : "failed" };
  }
  await updateVerification(payment.payment_id, {
    verificationResult: status === "COMPLETE" ? "SIGNED_RESPONSE_REQUIRED" : status,
  });
  return { outcome: status === "COMPLETE" ? "unverified" : "pending" };
}

function resultUrl(bookingId, result) {
  const url = new URL("payment-result.html", `${env.appBaseUrl.replace(/\/+$/, "")}/`);
  url.searchParams.set("bookingId", String(bookingId));
  url.searchParams.set("result", result);
  return url.toString();
}

async function handleEsewaCallback(req, res) {
  const transactionUuid = String(req.params.transactionUuid || req.query.transaction_uuid || "");
  if (!/^[A-Za-z0-9-]{1,100}$/.test(transactionUuid)) {
    return res.redirect(303, resultUrl("", "unverified"));
  }

  try {
    const payment = await getCallbackPayment(transactionUuid);
    if (!payment) return res.redirect(303, resultUrl("", "unverified"));

    if (payment.status === "PAID") {
      return res.redirect(303, resultUrl(payment.booking_id, "success"));
    }

    // Express decodes query-string '+' characters as spaces; Base64 data cannot contain spaces.
    const encodedData = typeof req.query.data === "string" ? req.query.data.replace(/ /g, "+") : null;
    const signedResponse = encodedData ? decodeResponse(encodedData) : null;
    if (req.query.data && !signedResponse) {
      await updateVerification(payment.payment_id, { verificationResult: "INVALID_RESPONSE" });
      return res.redirect(303, resultUrl(payment.booking_id, "unverified"));
    }

    let callbackVerified = false;
    if (signedResponse) {
      const responseSignatureValid = verifyResponseSignature(signedResponse, env.esewa.secretKey);
      const callbackAmount = toMinorUnits(signedResponse.total_amount);
      if (!responseSignatureValid ||
          signedResponse.transaction_uuid !== payment.transaction_uuid ||
          signedResponse.product_code !== env.esewa.productCode ||
          callbackAmount !== toMinorUnits(payment.amount)) {
        await updateVerification(payment.payment_id, {
          verificationResult: responseSignatureValid ? "CALLBACK_MISMATCH" : "INVALID_SIGNATURE",
        });
        return res.redirect(303, resultUrl(payment.booking_id, "unverified"));
      }
      callbackVerified = signedResponse.status === "COMPLETE";
      if (callbackVerified) {
        await db.transaction((tx) => tx.query(
          "UPDATE payments SET callback_signature_valid = TRUE WHERE id = ? AND status = 'PENDING'",
          [payment.payment_id]
        ));
      }
    }

    const result = await applyVerification(payment, callbackVerified);
    return res.redirect(303, resultUrl(payment.booking_id, result.outcome));
  } catch (error) {
    console.error("eSewa callback processing failed:", error.message);
    return res.redirect(303, resultUrl("", "pending"));
  }
}

router.get("/esewa/success", handleEsewaCallback);
router.get("/esewa/failure", handleEsewaCallback);
router.get("/esewa/success/:transactionUuid", handleEsewaCallback);
router.get("/esewa/failure/:transactionUuid", handleEsewaCallback);

router.get("/:bookingId", authenticateToken, (req, res) => {
  const bookingId = toId(req.params.bookingId);
  if (bookingId === null) return res.status(400).json({ message: "Invalid booking ID." });
  const sql = `
    SELECT b.id AS booking_id, b.booking_reference, b.passenger_name, b.passenger_phone,
           b.passenger_age, b.amount, b.currency, b.status AS booking_status, b.created_at,
           f.flight_name, f.source, f.destination, f.departure_time, f.duration,
           p.id AS payment_id, p.transaction_uuid, p.provider, p.status AS payment_status,
           p.provider_reference, p.verification_result, p.created_at AS payment_created_at
    FROM bookings b
    JOIN flights f ON f.id = b.flight_id
    LEFT JOIN payments p ON p.id = (
      SELECT MAX(p2.id) FROM payments p2 WHERE p2.booking_id = b.id
    )
    WHERE b.id = ? AND b.user_id = ?
  `;
  db.query(sql, [bookingId, req.user.id], (error, rows) => {
    if (error) return res.status(500).json({ message: "Database error while loading payment status." });
    if (!rows.length) return res.status(404).json({ message: "Booking not found." });
    res.json(rows[0]);
  });
});

router.post("/:bookingId/verify", authenticateToken, async (req, res) => {
  const bookingId = toId(req.params.bookingId);
  if (bookingId === null) return res.status(400).json({ message: "Invalid booking ID." });
  try {
    const payments = await queryRows(
      `SELECT p.id AS payment_id, p.booking_id, p.transaction_uuid, p.amount, p.currency,
              p.status, p.callback_signature_valid
       FROM payments p JOIN bookings b ON b.id = p.booking_id
       WHERE b.id = ? AND b.user_id = ?
       ORDER BY p.id DESC LIMIT 1`,
      [bookingId, req.user.id]
    );
    const payment = payments[0];
    if (!payment) return res.status(404).json({ message: "Booking not found." });
    if (payment.status === "PAID") return res.json({ status: "PAID" });
    if (payment.status !== "PENDING") return res.json({ status: payment.status });
    const result = await applyVerification(payment, Boolean(payment.callback_signature_valid));
    res.json({ status: result.outcome.toUpperCase() });
  } catch (error) {
    console.error("eSewa payment re-verification failed:", error.message);
    res.status(502).json({ message: "Unable to verify payment with eSewa. Please try again." });
  }
});

router.post("/:bookingId/retry", authenticateToken, async (req, res) => {
  if (!paymentIsConfigured()) return res.status(503).json({ message: "eSewa UAT payment is not configured." });
  const bookingId = toId(req.params.bookingId);
  if (bookingId === null) return res.status(400).json({ message: "Invalid booking ID." });

  try {
    const payment = await db.transaction(async (tx) => {
      const [bookings] = await tx.query(
        "SELECT id, user_id, amount, currency, status FROM bookings WHERE id = ? FOR UPDATE",
        [bookingId]
      );
      const booking = bookings[0];
      if (!booking || Number(booking.user_id) !== Number(req.user.id)) return { error: "not_found" };
      if (booking.status !== "PAYMENT_FAILED") return { error: "not_retryable" };

      const transactionUuid = createTransactionUuid();
      const [created] = await tx.query(
        "INSERT INTO payments (booking_id, transaction_uuid, provider, amount, currency, status, verification_result) VALUES (?, ?, 'esewa', ?, ?, 'PENDING', 'AWAITING_PAYMENT')",
        [booking.id, transactionUuid, booking.amount, booking.currency]
      );
      await tx.query("UPDATE bookings SET status = 'PENDING', updated_at = CURRENT_TIMESTAMP WHERE id = ?", [booking.id]);
      return { id: created.insertId, booking_id: booking.id, transaction_uuid: transactionUuid, amount: booking.amount };
    });

    if (payment.error === "not_found") return res.status(404).json({ message: "Booking not found." });
    if (payment.error === "not_retryable") {
      return res.status(409).json({ message: "Only failed eSewa payments can be retried." });
    }
    res.json({
      message: "Payment initialized.",
      booking_id: payment.booking_id,
      ...createPaymentForm(payment),
    });
  } catch (error) {
    console.error("eSewa payment retry failed:", error.message);
    res.status(500).json({ message: "Unable to initialize the payment retry." });
  }
});

module.exports = {
  router,
  createPaymentForm,
  paymentIsConfigured,
};
