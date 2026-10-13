const crypto = require("crypto");
const express = require("express");
const env = require("../config/env");
const { createSignature, decodeResponse, formatAmount, toMinorUnits, verifyResponseSignature } = require("../utils/esewa");

const router = express.Router();
const SIGNED_REQUEST_FIELDS = "total_amount,transaction_uuid,product_code";
const MAX_AMOUNT_MINOR_UNITS = 1_000_000_000;
const VERIFICATION_TIMEOUT_MS = 10000;
const orders = new Map();

function baseUrl(pathname) {
  return new URL(pathname, `${env.appBaseUrl}/`).toString();
}

function isLocalRequest(req) {
  return ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress);
}

function mockModeRequired(req, res, next) {
  if (env.paymentMode !== "mock") return res.status(404).json({ message: "Not found." });
  if (!isLocalRequest(req)) return res.status(403).json({ message: "The mock payment gateway is available only from localhost." });
  next();
}

function mockFormModeRequired(req, res, next) {
  if (env.paymentMode !== "mock") return res.status(404).type("text/plain").send("Not found.");
  if (!isLocalRequest(req)) return res.status(403).type("text/plain").send("The mock gateway is available only from localhost.");
  next();
}

function createUuid() {
  return `ORD-${Date.now().toString(36)}-${crypto.randomBytes(8).toString("hex")}`;
}

function signatureMessage(totalAmount, transactionUuid, productCode) {
  return `total_amount=${totalAmount},transaction_uuid=${transactionUuid},product_code=${productCode}`;
}

function sign(fields, signedFieldNames) {
  const message = signatureMessage(fields.total_amount, fields.transaction_uuid, fields.product_code);
  console.info("[payment] signing request:", message);
  return createSignature(fields, signedFieldNames, env.esewa.secretKey);
}

function createPaymentOrder(amountMinorUnits) {
  const amount = formatAmount(amountMinorUnits / 100);
  const transactionUuid = createUuid();
  const successUrl = baseUrl("/api/pay/success");
  const failure = new URL(baseUrl("/api/pay/failure"));
  failure.searchParams.set("transaction_uuid", transactionUuid);
  const fields = {
    amount,
    tax_amount: "0",
    total_amount: amount,
    transaction_uuid: transactionUuid,
    product_code: env.esewa.productCode,
    product_service_charge: "0",
    product_delivery_charge: "0",
    success_url: successUrl,
    failure_url: failure.toString(),
    signed_field_names: SIGNED_REQUEST_FIELDS,
  };
  fields.signature = sign(fields, fields.signed_field_names);
  const order = {
    transactionUuid,
    amount,
    fields,
    successUrl,
    failureUrl: failure.toString(),
    status: "PENDING",
    gatewayStatus: "PENDING",
    transactionCode: null,
    verifying: false,
    createdAt: new Date().toISOString(),
  };
  orders.set(transactionUuid, order);
  return order;
}

function resultUrl(transactionUuid, outcome) {
  const result = new URL("/payment-result.html", `${env.appBaseUrl}/`);
  result.searchParams.set("transaction_uuid", transactionUuid || "");
  result.searchParams.set("outcome", outcome);
  return result.toString();
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

function renderMockGateway(order, message = "") {
  const uuid = escapeHtml(order.transactionUuid);
  const amount = escapeHtml(order.amount);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Local payment simulation</title>
  <style>
    *{box-sizing:border-box}body{margin:0;padding:2rem;background:#eef2f5;color:#263238;font:16px system-ui,sans-serif}
    main{max-width:460px;margin:4vh auto;padding:2rem;background:#fff;border-radius:14px;box-shadow:0 8px 30px #18304420}
    h1{margin-top:0;color:#168448}.badge{display:inline-block;padding:.35rem .6rem;border-radius:5px;background:#fff2cc;color:#694d00;font-size:.8rem;font-weight:700}
    .amount{font-size:1.6rem;font-weight:700}.check{display:flex;gap:.6rem;align-items:flex-start;margin:1.5rem 0}.check input{margin-top:.35rem}
    button{width:100%;padding:.8rem;margin-top:.7rem;border:0;border-radius:7px;font-weight:700;cursor:pointer}.pay{background:#168448;color:#fff}.cancel{background:#f1f3f4;color:#37474f}
    .notice{font-size:.9rem;color:#596970;line-height:1.5}.uuid{overflow-wrap:anywhere;font-size:.8rem;color:#607d8b}
    button:disabled{opacity:.55;cursor:not-allowed}dialog{max-width:380px;border:0;border-radius:12px;padding:1.5rem;box-shadow:0 12px 40px #10203055}dialog::backdrop{background:#10203088}
  </style>
</head>
<body><main>
  <span class="badge">LOCAL MOCK — NO REAL PAYMENT</span>
  <h1>Payment test</h1>
  <p>Amount: <span class="amount">NPR ${amount}</span></p>
  <p class="notice">${escapeHtml(message || "This local simulation does not connect to eSewa or process money. Never enter payment credentials or one-time codes here.")}</p>
  <label class="check"><input id="demo-check" type="checkbox"><span>I understand this is a demo payment only.</span></label>
  <button class="pay" id="continue-button" type="button" disabled>Continue to demo confirmation</button>
  <form method="post" action="/mock-esewa/cancel">
    <input type="hidden" name="transaction_uuid" value="${uuid}">
    <button class="cancel" type="submit">Cancel (Failure)</button>
  </form>
  <dialog id="demo-dialog" aria-labelledby="demo-title">
    <h2 id="demo-title">Demo token confirmation</h2>
    <p class="notice">No eSewa token, password, PIN, or CAPTCHA is requested or verified in this simulation.</p>
    <form method="post" action="/mock-esewa/complete">
      <input type="hidden" name="transaction_uuid" value="${uuid}">
      <input type="hidden" name="demo_confirmation" value="approved">
      <button class="pay" type="submit">Approve demo payment</button>
    </form>
    <button class="cancel" id="close-dialog" type="button">Back</button>
  </dialog>
  <p class="uuid">Transaction: ${uuid}</p>
</main><script>
  const demoCheck = document.getElementById("demo-check");
  const continueButton = document.getElementById("continue-button");
  const demoDialog = document.getElementById("demo-dialog");
  demoCheck.addEventListener("change", () => { continueButton.disabled = !demoCheck.checked; });
  continueButton.addEventListener("click", () => demoDialog.showModal());
  document.getElementById("close-dialog").addEventListener("click", () => demoDialog.close());
</script></body></html>`;
}

function getOrderFromRequest(req) {
  const transactionUuid = typeof req.body?.transaction_uuid === "string"
    ? req.body.transaction_uuid
    : typeof req.query.transaction_uuid === "string" ? req.query.transaction_uuid : "";
  return orders.get(transactionUuid) || null;
}

function validateInitiationAmount(value) {
  if (typeof value !== "number" && typeof value !== "string") return null;
  const amountMinorUnits = toMinorUnits(value);
  if (amountMinorUnits === null || amountMinorUnits <= 0 || amountMinorUnits > MAX_AMOUNT_MINOR_UNITS) return null;
  return amountMinorUnits;
}

async function requestGatewayStatus(order) {
  if (env.paymentMode === "mock") {
    const body = {
      product_code: env.esewa.productCode,
      transaction_uuid: order.transactionUuid,
      total_amount: Number(order.amount),
      status: order.gatewayStatus,
      ref_id: order.gatewayStatus === "COMPLETE" ? `MOCK-${order.transactionUuid.slice(-12)}` : null,
    };
    console.info("[payment] local mock status result:", body);
    return body;
  }

  const statusUrl = new URL(env.esewa.statusUrl);
  statusUrl.searchParams.set("product_code", env.esewa.productCode);
  statusUrl.searchParams.set("total_amount", order.amount);
  statusUrl.searchParams.set("transaction_uuid", order.transactionUuid);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), VERIFICATION_TIMEOUT_MS);
  try {
    const response = await fetch(statusUrl, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    if (!response.ok) throw new Error(`eSewa status check returned HTTP ${response.status}.`);
    const body = await response.json();
    console.info("[payment] eSewa status check result:", body);
    return body;
  } finally {
    clearTimeout(timeout);
  }
}

router.post("/api/pay/initiate", (req, res) => {
  if (!env.esewa.secretKey) return res.status(503).json({ message: "Payment signing is not configured on the server." });
  if (!["sandbox", "mock"].includes(env.paymentMode)) {
    return res.status(503).json({ message: "Unsupported payment mode." });
  }
  if (env.paymentMode === "mock" && !isLocalRequest(req)) {
    return res.status(403).json({ message: "The mock payment gateway is available only from localhost." });
  }
  const amountMinorUnits = validateInitiationAmount(req.body?.amount);
  if (amountMinorUnits === null) {
    return res.status(400).json({ message: "Amount must be a positive number no greater than NPR 10,000,000.00." });
  }
  const order = createPaymentOrder(amountMinorUnits);
  const formAction = env.paymentMode === "mock"
    ? baseUrl("/mock-esewa/form")
    : env.esewa.formUrl;
  console.info(`[payment] created ${env.paymentMode} order ${order.transactionUuid} for NPR ${order.amount}.`);
  res.status(201).json({
    ...order.fields,
    form_action: formAction,
  });
});

router.get("/api/pay/order/:transactionUuid", (req, res) => {
  if (env.paymentMode === "mock" && !isLocalRequest(req)) {
    return res.status(403).json({ message: "Mock order status is available only from localhost." });
  }
  const order = orders.get(req.params.transactionUuid);
  if (!order) return res.status(404).json({ message: "Payment order not found." });
  res.json({
    transaction_uuid: order.transactionUuid,
    amount: order.amount,
    status: order.status,
    transaction_code: order.transactionCode,
  });
});

router.all("/mock-esewa/form", mockFormModeRequired, (req, res) => {
  const order = getOrderFromRequest(req);
  if (!order) return res.status(404).type("text/plain").send("Mock payment order not found.");
  if (order.status !== "PENDING" || order.gatewayStatus !== "PENDING") {
    return res.status(409).type("text/plain").send("This mock payment attempt has already been processed.");
  }
  const validRequestSignature = createSignature(order.fields, SIGNED_REQUEST_FIELDS, env.esewa.secretKey);
  if (order.fields.signature !== validRequestSignature) {
    return res.status(400).type("text/plain").send("Mock payment request signature is invalid.");
  }
  res.type("html").send(renderMockGateway(order));
});

router.get("/mock-esewa/status", mockModeRequired, (req, res) => {
  const order = getOrderFromRequest(req);
  if (!order) return res.status(404).json({ message: "Mock payment order not found." });
  res.json({
    product_code: env.esewa.productCode,
    transaction_uuid: order.transactionUuid,
    total_amount: Number(order.amount),
    status: order.gatewayStatus,
    ref_id: order.gatewayStatus === "COMPLETE" ? `MOCK-${order.transactionUuid.slice(-12)}` : null,
  });
});

router.post("/mock-esewa/complete", mockFormModeRequired, (req, res) => {
  const order = getOrderFromRequest(req);
  if (!order) return res.status(404).type("text/plain").send("Mock payment order not found.");
  if (order.status !== "PENDING" || order.gatewayStatus !== "PENDING") {
    return res.status(409).type("text/plain").send("This mock payment attempt has already been processed.");
  }
  if (req.body.demo_confirmation !== "approved") {
    console.info(`[payment] rejected unconfirmed demo payment for ${order.transactionUuid}.`);
    return res.status(401).type("html").send(renderMockGateway(order, "Confirm the demo-only prompt to continue. No payment credentials are accepted."));
  }
  order.gatewayStatus = "COMPLETE";
  const response = {
    transaction_code: `MOCK-${order.transactionUuid.slice(-12)}`,
    status: "COMPLETE",
    total_amount: order.amount,
    transaction_uuid: order.transactionUuid,
    product_code: env.esewa.productCode,
    signed_field_names: "transaction_code,status,total_amount,transaction_uuid,product_code,signed_field_names",
  };
  response.signature = createSignature(response, response.signed_field_names, env.esewa.secretKey);
  const successUrl = new URL(order.successUrl);
  successUrl.searchParams.set("data", Buffer.from(JSON.stringify(response)).toString("base64"));
  console.info(`[payment] mock gateway completed ${order.transactionUuid}; returning signed response.`);
  res.redirect(303, successUrl.toString());
});

router.post("/mock-esewa/cancel", mockFormModeRequired, (req, res) => {
  const order = getOrderFromRequest(req);
  if (!order) return res.status(404).type("text/plain").send("Mock payment order not found.");
  if (order.status === "PENDING" && order.gatewayStatus === "PENDING") order.gatewayStatus = "CANCELED";
  res.redirect(303, order.failureUrl);
});

router.get("/api/pay/success", async (req, res) => {
  const rawData = typeof req.query.data === "string" ? req.query.data.replace(/ /g, "+") : "";
  const response = decodeResponse(rawData);
  if (!response) return res.redirect(303, resultUrl("", "INVALID_RESPONSE"));
  console.info("[payment] decoded provider response:", response);

  const order = orders.get(response.transaction_uuid);
  if (!order) return res.redirect(303, resultUrl(response.transaction_uuid, "NOT_FOUND"));
  if (order.status === "PAID") return res.redirect(303, resultUrl(order.transactionUuid, "PAID"));
  if (order.status !== "PENDING") return res.redirect(303, resultUrl(order.transactionUuid, order.status));
  if (order.verifying) return res.redirect(303, resultUrl(order.transactionUuid, "PENDING"));

  const signatureValid = verifyResponseSignature(response, env.esewa.secretKey);
  const responseAmount = toMinorUnits(response.total_amount);
  if (!signatureValid ||
      response.transaction_uuid !== order.transactionUuid ||
      response.product_code !== env.esewa.productCode ||
      responseAmount !== toMinorUnits(order.amount) ||
      response.status !== "COMPLETE") {
    console.warn(`[payment] rejected invalid or mismatched success response for ${order.transactionUuid}.`);
    return res.redirect(303, resultUrl(order.transactionUuid, "UNVERIFIED"));
  }

  order.verifying = true;
  try {
    const status = await requestGatewayStatus(order);
    const statusMatches = status.product_code === env.esewa.productCode &&
      status.transaction_uuid === order.transactionUuid &&
      toMinorUnits(status.total_amount) === toMinorUnits(order.amount);
    if (!statusMatches) {
      console.warn(`[payment] server-side status response did not match ${order.transactionUuid}.`);
      return res.redirect(303, resultUrl(order.transactionUuid, "UNVERIFIED"));
    }
    if (order.status !== "PENDING") {
      return res.redirect(303, resultUrl(order.transactionUuid, order.status));
    }
    if (status.status === "COMPLETE") {
      order.status = "PAID";
      order.transactionCode = response.transaction_code;
      console.info(`[payment] order ${order.transactionUuid} verified and marked PAID.`);
      return res.redirect(303, resultUrl(order.transactionUuid, "PAID"));
    }
    if (status.status === "NOT_FOUND" || status.status === "CANCELED") {
      order.status = "FAILED";
      return res.redirect(303, resultUrl(order.transactionUuid, status.status));
    }
    return res.redirect(303, resultUrl(order.transactionUuid, status.status || "PENDING"));
  } catch (error) {
    console.warn(`[payment] status verification failed for ${order.transactionUuid}: ${error.message}`);
    return res.redirect(303, resultUrl(order.transactionUuid, "PENDING"));
  } finally {
    order.verifying = false;
  }
});

router.get("/api/pay/failure", (req, res) => {
  const transactionUuid = typeof req.query.transaction_uuid === "string" ? req.query.transaction_uuid : "";
  const order = orders.get(transactionUuid);
  if (!order) return res.redirect(303, resultUrl(transactionUuid, "NOT_FOUND"));
  if (order.status === "PENDING" && !order.verifying) order.status = "FAILED";
  console.info(`[payment] failure callback received for ${order.transactionUuid}; current status ${order.status}.`);
  res.redirect(303, resultUrl(order.transactionUuid, order.status));
});

module.exports = router;
