// Razorpay helpers: signature checks + a tiny API client (no SDK needed, uses Node's built-in fetch).
const crypto = require("crypto");
const API_BASE = "https://api.razorpay.com/v1";

function safeEqual(a, b) {
  const x = Buffer.from(String(a || ""), "utf8");
  const y = Buffer.from(String(b || ""), "utf8");
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
const hmacHex = (secret, text) => crypto.createHmac("sha256", secret).update(text).digest("hex");

// Orders API: signature = HMAC_SHA256(order_id + "|" + payment_id, key_secret)
function verifyPaymentSignature({ orderId, paymentId, signature }, secret) {
  return Boolean(secret && orderId && paymentId && signature) && safeEqual(hmacHex(secret, `${orderId}|${paymentId}`), signature);
}
// Subscriptions: signature = HMAC_SHA256(payment_id + "|" + subscription_id, key_secret)
function verifySubscriptionSignature({ subscriptionId, paymentId, signature }, secret) {
  return Boolean(secret && subscriptionId && paymentId && signature) && safeEqual(hmacHex(secret, `${paymentId}|${subscriptionId}`), signature);
}
// Webhooks: X-Razorpay-Signature = HMAC_SHA256(raw request body, webhook_secret)
function verifyWebhookSignature(rawBody, signature, secret) {
  return Boolean(secret && signature && rawBody) && safeEqual(hmacHex(secret, Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : String(rawBody)), signature);
}

function isConfigured(keyId, keySecret) {
  return Boolean(keyId && keySecret && /^rzp_(test|live)_/.test(keyId) && !keyId.includes("PASTE") && !keySecret.includes("PASTE"));
}
const modeOf = keyId => (String(keyId || "").startsWith("rzp_live_") ? "live" : "test");

function createClient({ keyId, keySecret, fetchImpl }) {
  const doFetch = fetchImpl || fetch;
  async function request(method, endpoint, body) {
    if (!isConfigured(keyId, keySecret)) {
      const e = new Error("Razorpay keys are missing. Copy .env.example to .env and add your Razorpay TEST keys.");
      e.status = 503; throw e;
    }
    const res = await doFetch(`${API_BASE}${endpoint}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: "Basic " + Buffer.from(`${keyId}:${keySecret}`).toString("base64")
      },
      body: body ? JSON.stringify(body) : undefined
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const e = new Error((data.error && data.error.description) || `Razorpay API returned ${res.status}`);
      e.status = res.status >= 500 ? 502 : (res.status === 401 ? 503 : 400);
      e.code = data.error && data.error.code;
      throw e;
    }
    return data;
  }
  return {
    request,
    createOrder: body => request("POST", "/orders", body),
    fetchOrder: id => request("GET", `/orders/${encodeURIComponent(id)}`),
    fetchPayment: id => request("GET", `/payments/${encodeURIComponent(id)}`),
    createPlan: body => request("POST", "/plans", body),
    createSubscription: body => request("POST", "/subscriptions", body),
    fetchSubscription: id => request("GET", `/subscriptions/${encodeURIComponent(id)}`)
  };
}

module.exports = { verifyPaymentSignature, verifySubscriptionSignature, verifyWebhookSignature, createClient, isConfigured, modeOf, safeEqual };
