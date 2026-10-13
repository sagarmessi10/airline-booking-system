const assert = require("node:assert/strict");
process.env.PAYMENT_MODE = "mock";
process.env.ESEWA_PRODUCT_CODE = "EPAYTEST";
process.env.ESEWA_SECRET_KEY = "unit-test-only-secret";

const { createSignature } = require("../src/utils/esewa");
const app = require("../src/app");
const env = require("../src/config/env");

const documentedSignature = createSignature(
  { total_amount: "100", transaction_uuid: "11-201-13", product_code: "EPAYTEST" },
  "total_amount,transaction_uuid,product_code",
  "8gBm/:&EnhH.1/q"
);
assert.equal(documentedSignature, "5DZywcrTKD0gia/rsSMcrRHmJl+4Tbol6S+lWgdJ94E=");
assert.notEqual(documentedSignature, "4Ov7pCI1zIOdwtV2BRMUNjz1upIlT/COTxfLhWvVurE=");
assert.equal(
  createSignature(
    { total_amount: "110", transaction_uuid: "241028", product_code: "EPAYTEST" },
    "total_amount,transaction_uuid,product_code",
    "8gBm/:&EnhH.1/q"
  ),
  "i94zsd3oXF6ZsSr/kGqT4sSzYQzjj1W/waxjWyRwaME="
);
console.log("✔ eSewa HMAC-SHA256 calculation matches the documented form sample");

function signedResponse(order, overrides = {}, secret = env.esewa.secretKey) {
  const response = {
    transaction_code: "MOCK-TEST-001",
    status: "COMPLETE",
    total_amount: order.total_amount,
    transaction_uuid: order.transaction_uuid,
    product_code: order.product_code,
    signed_field_names: "transaction_code,status,total_amount,transaction_uuid,product_code,signed_field_names",
    ...overrides,
  };
  response.signature = createSignature(response, response.signed_field_names, secret);
  return Buffer.from(JSON.stringify(response)).toString("base64");
}

async function run() {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  env.appBaseUrl = `http://127.0.0.1:${server.address().port}`;
  const baseUrl = env.appBaseUrl;
  const request = (path, options) => fetch(new URL(path, baseUrl), { redirect: "manual", ...options });

  try {
    let response = await request("/api/pay/initiate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amount: 0 }),
    });
    assert.equal(response.status, 400);
    response = await request("/api/pay/initiate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amount: "not-an-amount" }),
    });
    assert.equal(response.status, 400);
    console.log("✔ invalid payment amounts are rejected");

    response = await request("/api/pay/initiate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amount: "100.25" }),
    });
    assert.equal(response.status, 201);
    const order = await response.json();
    assert.equal(order.amount, "100.25");
    assert.equal(order.total_amount, "100.25");
    assert.equal(order.form_action, `${baseUrl}/mock-esewa/form`);
    assert.equal(order.signed_field_names, "total_amount,transaction_uuid,product_code");
    assert.equal(
      order.signature,
      createSignature(order, order.signed_field_names, env.esewa.secretKey)
    );
    assert.ok(!JSON.stringify(order).includes(env.esewa.secretKey));
    console.log("✔ server signs and returns a secret-free mock checkout request");

    const requestFields = Object.fromEntries(
      Object.entries(order).filter(([key]) => key !== "form_action")
    );
    response = await request("/mock-esewa/form", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(requestFields),
    });
    assert.equal(response.status, 200);
    const gatewayHtml = await response.text();
    assert.match(gatewayHtml, /LOCAL MOCK — NO REAL PAYMENT/);
    assert.match(gatewayHtml, /<dialog[^>]*id="demo-dialog"/);
    assert.match(gatewayHtml, /Demo token confirmation/);
    assert.match(gatewayHtml, /No eSewa token, password, PIN, or CAPTCHA is requested/);
    assert.doesNotMatch(gatewayHtml, /name="(?:esewa_id|password|mpin|token)"/);
    console.log("✔ mock gateway shows a confirmation dialog without collecting payment credentials");

    response = await request(`/mock-esewa/status?transaction_uuid=${encodeURIComponent(order.transaction_uuid)}`);
    assert.deepEqual(await response.json(), {
      product_code: "EPAYTEST",
      transaction_uuid: order.transaction_uuid,
      total_amount: 100.25,
      status: "PENDING",
      ref_id: null,
    });

    response = await request("/mock-esewa/complete", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        transaction_uuid: order.transaction_uuid,
      }),
    });
    assert.equal(response.status, 401);
    console.log("✔ mock gateway requires explicit demo confirmation");

    response = await request("/mock-esewa/complete", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        transaction_uuid: order.transaction_uuid,
        demo_confirmation: "approved",
      }),
    });
    assert.equal(response.status, 303);
    const callbackUrl = response.headers.get("location");
    assert.ok(callbackUrl.includes("/api/pay/success?data="));

    const invalidCallback = new URL("/api/pay/success", baseUrl);
    invalidCallback.searchParams.set("data", signedResponse(order, {}, "incorrect-test-secret"));
    response = await request(invalidCallback.pathname + invalidCallback.search);
    assert.equal(response.status, 303);
    assert.match(response.headers.get("location"), /outcome=UNVERIFIED/);
    let statusResponse = await request(`/api/pay/order/${order.transaction_uuid}`);
    assert.equal((await statusResponse.json()).status, "PENDING");
    console.log("✔ invalid callback signatures cannot mark a payment paid");

    const successPath = new URL(callbackUrl).pathname + new URL(callbackUrl).search;
    const concurrentCallbacks = await Promise.all([
      request(successPath),
      request(successPath),
    ]);
    concurrentCallbacks.forEach((callback) => assert.equal(callback.status, 303));
    statusResponse = await request(`/api/pay/order/${order.transaction_uuid}`);
    const paidOrder = await statusResponse.json();
    assert.equal(paidOrder.status, "PAID");
    assert.equal(paidOrder.transaction_code, `MOCK-${order.transaction_uuid.slice(-12)}`);
    response = await request(`/api/pay/order/${order.transaction_uuid}`);
    assert.equal((await response.json()).status, "PAID");
    console.log("✔ verified and duplicate success callbacks are idempotent");

    response = await request("/api/pay/initiate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amount: 45 }),
    });
    const cancelledOrder = await response.json();
    response = await request("/mock-esewa/cancel", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ transaction_uuid: cancelledOrder.transaction_uuid }),
    });
    assert.equal(response.status, 303);
    assert.match(response.headers.get("location"), /\/api\/pay\/failure\?/);
    response = await request(new URL(response.headers.get("location")).pathname +
      new URL(response.headers.get("location")).search);
    assert.equal(response.status, 303);
    response = await request(`/api/pay/order/${cancelledOrder.transaction_uuid}`);
    assert.equal((await response.json()).status, "FAILED");
    console.log("✔ cancellation and failure callbacks mark an order failed");

    const duplicatePayment = await request("/mock-esewa/complete", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        transaction_uuid: order.transaction_uuid,
        demo_confirmation: "approved",
      }),
    });
    assert.equal(duplicatePayment.status, 409);
    console.log("✔ a processed transaction cannot be submitted a second time");

    env.paymentMode = "sandbox";
    response = await request("/api/pay/initiate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amount: 12.5 }),
    });
    const sandboxOrder = await response.json();
    assert.equal(response.status, 201);
    assert.equal(sandboxOrder.form_action, env.esewa.formUrl);
    assert.doesNotMatch(sandboxOrder.form_action, /localhost|mock-esewa/);
    response = await request("/mock-esewa/form");
    assert.equal(response.status, 404);
    env.paymentMode = "mock";
    console.log("✔ sandbox mode uses only the configured eSewa UAT form");
    console.log("All mock payment checks passed.");
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
