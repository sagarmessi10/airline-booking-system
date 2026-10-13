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
const UAT_FORM_URL = env.esewa.formUrl;
const UAT_STATUS_URL = env.esewa.statusUrl;
const VERIFICATION_TIMEOUT_MS = 10000;
const ESEWA_PAYMENT_STATUSES = new Set([
  "PENDING",
  "COMPLETE",
  "FULL_REFUND",
  "PARTIAL_REFUND",
  "AMBIGUOUS",
  "NOT_FOUND",
  "CANCELED",
]);
const mockTransactionStatuses = new Map();

function queryRows(sql, params) {
  return new Promise((resolve, reject) => {
    db.query(sql, params, (error, rows) => (error ? reject(error) : resolve(rows)));
  });
}

function paymentIsConfigured() {
  return ["mock", "sandbox"].includes(env.paymentMode) &&
    env.esewa.environment === "uat" &&
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
  const formUrl = env.paymentMode === "mock"
    ? `${env.apiBaseUrl}/payments/mock-esewa/form`
    : UAT_FORM_URL;
  return { formUrl, fields };
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
    const [payments] = await tx.query(
      `SELECT p.id, p.booking_id, p.status, b.flight_id, b.passenger_count, b.status AS booking_status
       FROM payments p JOIN bookings b ON b.id = p.booking_id WHERE p.id = ? FOR UPDATE`,
      [paymentId]
    );
    const payment = payments[0];
    if (!payment || payment.status === "PAID") return payment;

    if (terminalStatus === "PAID") {
      const [updated] = await tx.query(
        "UPDATE payments SET status = 'PAID', provider_reference = ?, verification_result = ?, verified_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'PENDING'",
        [result.providerReference, result.verificationResult, paymentId]
      );
      if (updated.affectedRows === 1) {
        const [inventory] = await tx.query(
          `UPDATE flights SET seats_reserved = seats_reserved - ?,
           seats_booked = seats_booked + ? WHERE id = ? AND seats_reserved >= ?`,
          [payment.passenger_count, payment.passenger_count, payment.flight_id, payment.passenger_count]
        );
        if (inventory.affectedRows !== 1) throw new Error("Reserved domestic seat inventory is inconsistent.");
        await tx.query(
          "UPDATE bookings SET status = 'CONFIRMED', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'PENDING'",
          [payment.booking_id]
        );
      }
    } else if (terminalStatus === "FAILED") {
      const [updated] = await tx.query(
        "UPDATE payments SET status = 'FAILED', verification_result = ? WHERE id = ? AND status = 'PENDING'",
        [result.verificationResult, paymentId]
      );
      if (updated.affectedRows === 1) {
        const [bookingUpdate] = await tx.query(
          "UPDATE bookings SET status = 'PAYMENT_FAILED', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status <> 'CONFIRMED'",
          [payment.booking_id]
        );
        if (bookingUpdate.affectedRows === 1 && payment.booking_status === "PENDING") {
          const [inventory] = await tx.query(
            "UPDATE flights SET seats_reserved = seats_reserved - ? WHERE id = ? AND seats_reserved >= ?",
            [payment.passenger_count, payment.flight_id, payment.passenger_count]
          );
          if (inventory.affectedRows !== 1) throw new Error("Reserved domestic seat inventory is inconsistent.");
        }
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
  if (env.paymentMode === "mock") {
    const body = {
      product_code: env.esewa.productCode,
      transaction_uuid: payment.transaction_uuid,
      total_amount: Number(formatAmount(payment.amount)),
      status: mockTransactionStatuses.get(payment.transaction_uuid) || "PENDING",
      ref_id: `MOCK-${payment.transaction_uuid.slice(-12)}`,
    };
    console.info(`[mock payment] server-side status result for ${payment.transaction_uuid}: ${body.status}`);
    return { kind: "status", body };
  }

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
    if (!body || typeof body.status !== "string" || !ESEWA_PAYMENT_STATUSES.has(body.status)) {
      console.warn("eSewa UAT status service returned an invalid response.");
      return { kind: "unavailable" };
    }
    if (body.product_code !== env.esewa.productCode ||
        body.transaction_uuid !== payment.transaction_uuid ||
        toMinorUnits(body.total_amount) !== toMinorUnits(payment.amount)) {
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
      providerReference: verification.body.ref_id || null,
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

function mockGatewayPage(fields, message = "") {
  const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
  const uuid = escapeHtml(fields.transaction_uuid);
  const amount = escapeHtml(fields.total_amount);
  const notice = escapeHtml(message ||
    "This local simulation does not connect to eSewa or process money. Never enter payment credentials or one-time codes here.");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Local payment simulation</title><style>
*{box-sizing:border-box}body{margin:0;padding:2rem;background:#eef2f5;color:#263238;font:16px system-ui,sans-serif}
main{max-width:460px;margin:4vh auto;padding:2rem;background:#fff;border-radius:14px;box-shadow:0 8px 30px #18304420}
h1{color:#168448}.badge{padding:.35rem .6rem;border-radius:5px;background:#fff2cc;color:#694d00;font-size:.8rem;font-weight:700}
.notice{font-size:.9rem;color:#596970;line-height:1.5}.check{display:flex;gap:.6rem;align-items:flex-start;margin:1.5rem 0}.check input{margin-top:.35rem}
button{width:100%;padding:.8rem;margin-top:.7rem;border:0;border-radius:7px;font-weight:700;cursor:pointer}.pay{background:#168448;color:#fff}.cancel{background:#f1f3f4;color:#37474f}.uuid{overflow-wrap:anywhere;font-size:.8rem;color:#607d8b}
button:disabled{opacity:.55;cursor:not-allowed}dialog{max-width:380px;border:0;border-radius:12px;padding:1.5rem;box-shadow:0 12px 40px #10203055}dialog::backdrop{background:#10203088}
</style></head><body><main><span class="badge">LOCAL MOCK — NO REAL PAYMENT</span><h1>Payment test</h1>
<p>Amount: <strong>NPR ${amount}</strong></p><p class="notice">${notice}</p>
<label class="check"><input id="demo-check" type="checkbox"><span>I understand this is a demo payment only.</span></label>
<button class="pay" id="continue-button" type="button" disabled>Continue to demo confirmation</button>
<form method="post" action="/payments/mock-esewa/cancel"><input type="hidden" name="transaction_uuid" value="${uuid}">
<button class="cancel" type="submit">Cancel (Failure)</button></form>
<dialog id="demo-dialog" aria-labelledby="demo-title"><h2 id="demo-title">Demo token confirmation</h2>
<p class="notice">No eSewa token, password, PIN, or CAPTCHA is requested or verified in this simulation.</p>
<form method="post" action="/payments/mock-esewa/complete"><input type="hidden" name="transaction_uuid" value="${uuid}">
<input type="hidden" name="demo_confirmation" value="approved"><button class="pay" type="submit">Approve demo payment</button></form>
<button class="cancel" id="close-dialog" type="button">Back</button></dialog><p class="uuid">Transaction: ${uuid}</p>
</main><script>
const demoCheck = document.getElementById("demo-check");
const continueButton = document.getElementById("continue-button");
const demoDialog = document.getElementById("demo-dialog");
demoCheck.addEventListener("change", () => { continueButton.disabled = !demoCheck.checked; });
continueButton.addEventListener("click", () => demoDialog.showModal());
document.getElementById("close-dialog").addEventListener("click", () => demoDialog.close());
</script></body></html>`;
}

async function loadPendingMockPayment(transactionUuid) {
  const payment = await getCallbackPayment(transactionUuid);
  if (!payment || payment.status !== "PENDING") return null;
  return { payment, fields: createPaymentForm(payment).fields };
}

function mockModeOnly(req, res, next) {
  if (env.paymentMode !== "mock") return res.status(404).type("text/plain").send("Not found.");
  if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress)) {
    return res.status(403).type("text/plain").send("Mock gateway is available only from localhost.");
  }
  next();
}

router.post("/mock-esewa/form", mockModeOnly, async (req, res) => {
  try {
    const transactionUuid = typeof req.body?.transaction_uuid === "string" ? req.body.transaction_uuid : "";
    const order = await loadPendingMockPayment(transactionUuid);
    if (!order) return res.status(404).type("text/plain").send("Pending mock payment not found.");
    if (req.body.product_code !== env.esewa.productCode ||
        req.body.total_amount !== order.fields.total_amount ||
        req.body.signature !== order.fields.signature) {
      return res.status(400).type("text/plain").send("Mock payment form signature or order details are invalid.");
    }
    mockTransactionStatuses.set(transactionUuid, "PENDING");
    res.type("html").send(mockGatewayPage(order.fields));
  } catch (error) {
    console.error("Mock gateway form failed:", error.message);
    res.status(500).type("text/plain").send("Unable to load the local mock gateway.");
  }
});

router.post("/mock-esewa/complete", mockModeOnly, async (req, res) => {
  const transactionUuid = typeof req.body?.transaction_uuid === "string" ? req.body.transaction_uuid : "";
  try {
    const order = await loadPendingMockPayment(transactionUuid);
    if (!order) return res.status(409).type("text/plain").send("This mock payment is missing or has already been processed.");
    if (req.body.demo_confirmation !== "approved") {
      console.info(`[mock payment] rejected unconfirmed demo payment for ${transactionUuid}.`);
      return res.status(401).type("html").send(
        mockGatewayPage(order.fields, "Confirm the demo-only prompt to continue. No payment credentials are accepted.")
      );
    }

    const signedResponse = {
      transaction_code: `MOCK-${transactionUuid.slice(-12)}`,
      status: "COMPLETE",
      total_amount: order.fields.total_amount,
      transaction_uuid: transactionUuid,
      product_code: env.esewa.productCode,
      signed_field_names: "transaction_code,status,total_amount,transaction_uuid,product_code,signed_field_names",
    };
    signedResponse.signature = createSignature(
      signedResponse,
      signedResponse.signed_field_names,
      env.esewa.secretKey
    );
    mockTransactionStatuses.set(transactionUuid, "COMPLETE");
    const successUrl = new URL(order.fields.success_url);
    successUrl.searchParams.set("data", Buffer.from(JSON.stringify(signedResponse)).toString("base64"));
    console.info(`[mock payment] generated signed success response for ${transactionUuid}.`);
    res.redirect(303, successUrl.toString());
  } catch (error) {
    console.error("Mock payment completion failed:", error.message);
    res.status(500).type("text/plain").send("Unable to complete the local mock payment.");
  }
});

router.post("/mock-esewa/cancel", mockModeOnly, async (req, res) => {
  const transactionUuid = typeof req.body?.transaction_uuid === "string" ? req.body.transaction_uuid : "";
  try {
    const order = await loadPendingMockPayment(transactionUuid);
    if (!order) return res.status(409).type("text/plain").send("This mock payment is missing or has already been processed.");
    mockTransactionStatuses.set(transactionUuid, "CANCELED");
    res.redirect(303, order.fields.failure_url);
  } catch (error) {
    console.error("Mock payment cancellation failed:", error.message);
    res.status(500).type("text/plain").send("Unable to cancel the local mock payment.");
  }
});

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
    SELECT b.id AS booking_id, b.booking_reference, b.flight_id, b.passenger_name, b.passenger_phone,
           b.passenger_age, b.passenger_count, b.amount, b.currency, b.status AS booking_status, b.created_at,
           f.flight_name, f.departure_time, f.duration, f.flight_date,
           r.origin_iata AS source, origin.city AS source_name,
           r.destination_iata AS destination, destination.city AS destination_name,
           p.id AS payment_id, p.transaction_uuid, p.provider, p.status AS payment_status,
           p.provider_reference, p.verification_result, p.created_at AS payment_created_at
    FROM bookings b
    JOIN flights f ON f.id = b.flight_id
    LEFT JOIN domestic_routes r ON r.id = f.route_id
    LEFT JOIN domestic_airports origin ON origin.iata = r.origin_iata
    LEFT JOIN domestic_airports destination ON destination.iata = r.destination_iata
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
        "SELECT id, user_id, flight_id, passenger_count, amount, currency, status FROM bookings WHERE id = ? FOR UPDATE",
        [bookingId]
      );
      const booking = bookings[0];
      if (!booking || Number(booking.user_id) !== Number(req.user.id)) return { error: "not_found" };
      if (booking.status !== "PAYMENT_FAILED") return { error: "not_retryable" };

      const [reserved] = await tx.query(
        `UPDATE flights SET seats_reserved = seats_reserved + ?
         WHERE id = ? AND flight_date >= CURDATE()
           AND seat_capacity - seats_reserved - seats_booked >= ?`,
        [booking.passenger_count, booking.flight_id, booking.passenger_count]
      );
      if (reserved.affectedRows !== 1) return { error: "sold_out" };
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
    if (payment.error === "sold_out") {
      return res.status(409).json({ message: "Seats are no longer available for this schedule; contact support before retrying payment." });
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
