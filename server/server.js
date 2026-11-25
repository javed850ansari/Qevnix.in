require("dotenv").config();
const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = Number(process.env.PORT || 4242);
// Set DATA_DIR to a mounted persistent volume (for example /var/data) when available.
// Without it, files remain in the service folder (temporary on many cloud hosts).
const DATA_DIR = process.env.DATA_DIR || __dirname;
fs.mkdirSync(DATA_DIR, { recursive: true });
const rzp = require("./razorpay");
const razorpay = rzp.createClient({ keyId: process.env.RAZORPAY_KEY_ID, keySecret: process.env.RAZORPAY_KEY_SECRET });
const paymentMode = rzp.modeOf(process.env.RAZORPAY_KEY_ID);

app.set("trust proxy", 1); // needed on hosts like Render so req.ip is the real visitor IP
// FRONTEND_ORIGIN can list several websites separated by commas, e.g. https://qevnix.in,https://www.qevnix.in
const defaultAllowedOrigins = [
  "https://qevnix.in",
  "https://www.qevnix.in",
  "https://qevnix.netlify.app",
  "http://localhost:4242"
];
const configuredOrigins = (process.env.FRONTEND_ORIGIN || "").split(",").map(x => x.trim().replace(/\/$/, "")).filter(Boolean);
const allowedOrigins = new Set([...defaultAllowedOrigins, ...configuredOrigins]);
app.use(cors({
  origin(origin, callback) {
    // Allow server-to-server / health checks with no Origin header.
    if (!origin || allowedOrigins.has(origin.replace(/\/$/, ""))) return callback(null, true);
    return callback(new Error("Origin not allowed by QEVNIX CORS policy"));
  },
  methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "x-admin-token"],
  optionsSuccessStatus: 204
}));
app.use(express.json({ limit: "50kb", verify: (req, res, buf) => { req.rawBody = buf; } }));
// Serve ONLY the public/ folder. Never serve the server/ folder: it holds reviews.json,
// projects.json (customer records) and .env.
const NOINDEX_PATHS = ["/admin-reviews.html", "/admin-projects.html", "/customer-portal.html", "/manage-subscription.html", "/payment-return.html", "/subscription-return.html"];
app.use(NOINDEX_PATHS, (req, res, next) => { res.set("X-Robots-Tag", "noindex, nofollow"); next(); });
app.use(express.static(path.join(__dirname, "..", "public"), { dotfiles: "deny" }));

// Simple review moderation starter. For production, use a persistent database/storage volume.
const REVIEWS_FILE = process.env.REVIEWS_FILE || path.join(DATA_DIR, "reviews.json");
function readReviews() {
  try { return JSON.parse(fs.readFileSync(REVIEWS_FILE, "utf8")); }
  catch (e) { if (e.code === "ENOENT") return []; throw e; }
}
function writeReviews(items) {
  fs.mkdirSync(path.dirname(REVIEWS_FILE), { recursive: true });
  fs.writeFileSync(REVIEWS_FILE, JSON.stringify(items, null, 2), { mode: 0o600 });
}
function adminAuthorized(req) {
  const token = process.env.ADMIN_REVIEW_TOKEN;
  const supplied = String(req.headers["x-admin-token"] || "");
  return Boolean(token && token.length >= 24 && supplied && token.length === supplied.length && crypto.timingSafeEqual(Buffer.from(token), Buffer.from(supplied)));
}

const products = {
  website_basic: { type: "one_time", amount: 1999, label: "QEVNIX Basic Website" },
  website_business: { type: "one_time", amount: 3999, label: "QEVNIX Business Website" },
  website_premium: { type: "one_time", amount: 6999, label: "QEVNIX Premium Website" },
  maintenance_basic: { type: "subscription", amount: 999, label: "QEVNIX Basic Maintenance" },
  maintenance_standard: { type: "subscription", amount: 1999, label: "QEVNIX Standard Maintenance" },
  maintenance_premium: { type: "subscription", amount: 3999, label: "QEVNIX Premium Maintenance" },
  google_profile_setup: { type: "one_time", amount: 999, label: "QEVNIX Google Business Profile Setup (starting price)" },
  google_profile_management: { type: "subscription", amount: 999, label: "QEVNIX Google Profile Management (monthly starting price)" },
  business_growth_package: { type: "one_time", amount: 5999, label: "QEVNIX Business Growth Package (starting price)" },
  hospital_basic: { type: "one_time", amount: 14999, label: "QEVNIX Basic Hospital Website" },
  hospital_professional: { type: "one_time", amount: 24999, label: "QEVNIX Professional Hospital Website" },
  hospital_premium: { type: "one_time", amount: 39999, label: "QEVNIX Premium Hospital Website" }
};

// Simple per-IP limiter for public payment endpoints (each call creates a Razorpay API request).
const rateHits = new Map();
function rateLimit(name, limit, windowMs) {
  return (req, res, next) => {
    const key = `${name}:${req.ip}`; const now = Date.now();
    let r = rateHits.get(key);
    if (!r || now - r.first > windowMs) { r = { count: 0, first: now }; rateHits.set(key, r); }
    r.count += 1;
    if (r.count > limit) return res.status(429).json({ error: "Too many requests. Please try again in a few minutes." });
    next();
  };
}
setInterval(() => { const now = Date.now(); for (const [k, v] of rateHits) if (now - v.first > 60 * 60 * 1000) rateHits.delete(k); }, 10 * 60 * 1000).unref();

// Record of payments/subscriptions (updated by verify + webhook). Kept outside public/.
const PAYMENTS_FILE = process.env.PAYMENTS_FILE || path.join(DATA_DIR, "payments.json");
function readPayments() {
  try { return JSON.parse(fs.readFileSync(PAYMENTS_FILE, "utf8")); }
  catch (e) { if (e.code === "ENOENT") return {}; throw e; }
}
function upsertPayment(key, fields) {
  try {
    const all = readPayments();
    all[key] = { ...(all[key] || {}), ...fields, updatedAt: new Date().toISOString() };
    fs.mkdirSync(path.dirname(PAYMENTS_FILE), { recursive: true });
    const tmp = PAYMENTS_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(all, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, PAYMENTS_FILE);
  } catch (e) { console.error("Could not record payment:", e.message); }
}
// Razorpay retries webhook deliveries. Persist event IDs so a repeated delivery is safe.
const WEBHOOK_EVENTS_FILE = process.env.WEBHOOK_EVENTS_FILE || path.join(DATA_DIR, "webhook-events.json");
function readWebhookEvents() {
  try { const v = JSON.parse(fs.readFileSync(WEBHOOK_EVENTS_FILE, "utf8")); return Array.isArray(v) ? v : []; }
  catch (e) { return []; } // missing or unreadable file: treat as "no events seen yet"
}
function hasWebhookEvent(eventId) { return Boolean(eventId) && readWebhookEvents().includes(eventId); }
function rememberWebhookEvent(eventId) {
  if (!eventId) return true; // Older/test deliveries may not include the event-id header.
  const ids = readWebhookEvents();
  if (ids.includes(eventId)) return false;
  ids.push(eventId);
  // Keep a bounded history to prevent the file growing forever.
  const recent = ids.slice(-5000);
  fs.mkdirSync(path.dirname(WEBHOOK_EVENTS_FILE), { recursive: true });
  const tmp = WEBHOOK_EVENTS_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(recent), { mode: 0o600 });
  fs.renameSync(tmp, WEBHOOK_EVENTS_FILE);
  return true;
}
function cleanCustomer(body) {
  const customer = (body && body.customer) || {};
  const phone = String(customer.phone || "").replace(/\D/g, "").slice(-10);
  const email = String(customer.email || "").trim().slice(0, 120);
  const name = String(customer.name || "QEVNIX Customer").trim().replace(/[^\w .'-]/g, "").slice(0, 80) || "QEVNIX Customer";
  const ok = phone.length === 10 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  return { ok, phone, email, name };
}
const ID_RE = /^[A-Za-z0-9_]{6,60}$/;

// Public visitors can only see reviews approved by the QEVNIX admin.
app.get("/api/reviews", (req, res) => {
  try {
    const approved = readReviews().filter(r => r.status === "approved").map(({ id, name, rating, message, createdAt }) => ({ id, name, rating, message, createdAt }));
    res.json({ reviews: approved });
  } catch (e) { res.status(500).json({ error: "Could not load reviews." }); }
});

app.post("/api/reviews", (req, res) => {
  try {
    const name = String(req.body.name || "").trim().replace(/[<>]/g, "").slice(0, 60);
    const message = String(req.body.message || "").trim().replace(/[<>]/g, "").slice(0, 1000);
    const rating = Number(req.body.rating);
    const permission = req.body.permission === true;
    if (name.length < 2 || message.length < 10 || !Number.isInteger(rating) || rating < 1 || rating > 5 || !permission) {
      return res.status(400).json({ error: "Please enter your name, a review of at least 10 characters, select a 1–5 star rating and give permission to publish if approved." });
    }
    const items = readReviews();
    if (items.length >= 5000) return res.status(429).json({ error: "Review submissions are temporarily closed." });
    const review = { id: crypto.randomUUID(), name, rating, message, status: "pending", createdAt: new Date().toISOString() };
    items.push(review); writeReviews(items);
    res.status(201).json({ received: true, message: "Thank you! Your review has been sent for admin approval." });
  } catch (e) { console.error("Review submission:", e.message); res.status(500).json({ error: "Could not submit your review. Please try again later." }); }
});

app.get("/api/admin/reviews", (req, res) => {
  if (!adminAuthorized(req)) return res.status(401).json({ error: "Admin access denied." });
  try { res.json({ reviews: readReviews() }); }
  catch (e) { res.status(500).json({ error: "Could not load review submissions." }); }
});

app.patch("/api/admin/reviews/:id", (req, res) => {
  if (!adminAuthorized(req)) return res.status(401).json({ error: "Admin access denied." });
  const status = req.body.status;
  if (!["approved", "rejected"].includes(status)) return res.status(400).json({ error: "Status must be approved or rejected." });
  try {
    const items = readReviews();
    const item = items.find(r => r.id === req.params.id);
    if (!item) return res.status(404).json({ error: "Review not found." });
    item.status = status; item.moderatedAt = new Date().toISOString();
    writeReviews(items); res.json({ updated: true, review: item });
  } catch (e) { res.status(500).json({ error: "Could not update review." }); }
});

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    provider: "razorpay",
    mode: paymentMode,
    credentialsConfigured: rzp.isConfigured(process.env.RAZORPAY_KEY_ID, process.env.RAZORPAY_KEY_SECRET),
    webhookSecretConfigured: Boolean(process.env.RAZORPAY_WEBHOOK_SECRET),
    subscriptionPlansConfigured: Object.keys(products).filter(c => products[c].type === "subscription" && process.env[planEnvName(c)]).length
  });
});

// Public price list so the checkout form can show amounts (the server still decides the real amount).
const GST_RATE = 18;
const money2 = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
app.get("/api/products", (req, res) => {
  res.json({ products: Object.entries(products).map(([code, p]) => {
    const gstAmount = p.type === "one_time" ? money2(p.amount * GST_RATE / 100) : 0;
    return { code, type: p.type, amount: p.amount, label: p.label, gstRate: p.type === "one_time" ? GST_RATE : 0, gstAmount, totalWithGst: money2(p.amount + gstAmount) };
  }) });
});



// Customer project tracking starter. Admin creates customer accounts and assigns projects.
// For production, use a managed database, HTTPS, rate limiting and a dedicated session store.
const PROJECTS_FILE = process.env.PROJECTS_FILE || path.join(DATA_DIR, "projects.json");
const projectSessions = new Map(); // token -> { email, expires }
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;      // customers must sign in again after 8 hours
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const loginAttempts = new Map();                  // key -> { count, first }
function tooManyAttempts(key, limit) {
  const r = loginAttempts.get(key);
  if (!r) return false;
  if (Date.now() - r.first > ATTEMPT_WINDOW_MS) { loginAttempts.delete(key); return false; }
  return r.count >= limit;
}
function recordFailure(keys) {
  for (const key of keys) {
    const r = loginAttempts.get(key);
    if (!r || Date.now() - r.first > ATTEMPT_WINDOW_MS) loginAttempts.set(key, { count: 1, first: Date.now() });
    else r.count += 1;
  }
}
setInterval(() => {
  const now = Date.now();
  for (const [t, v] of projectSessions) if (v.expires < now) projectSessions.delete(t);
  for (const [k, v] of loginAttempts) if (now - v.first > ATTEMPT_WINDOW_MS) loginAttempts.delete(k);
}, 10 * 60 * 1000).unref();
function readProjectData() {
  try { return JSON.parse(fs.readFileSync(PROJECTS_FILE, "utf8")); }
  catch (e) { if (e.code === "ENOENT") return { customers: [], projects: [] }; throw e; }
}
function writeProjectData(data) {
  fs.mkdirSync(path.dirname(PROJECTS_FILE), { recursive: true });
  fs.writeFileSync(PROJECTS_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
}
function projectAdminAuthorized(req) {
  const token = process.env.ADMIN_PROJECT_TOKEN;
  const supplied = String(req.headers["x-admin-token"] || "");
  return Boolean(token && token.length >= 24 && supplied && token.length === supplied.length && crypto.timingSafeEqual(Buffer.from(token), Buffer.from(supplied)));
}
function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString("hex");
}
function customerFromRequest(req) {
  const auth = String(req.headers.authorization || "");
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const session = projectSessions.get(token);
  if (!session) return null;
  if (session.expires < Date.now()) { projectSessions.delete(token); return null; }
  const email = session.email;
  const data = readProjectData();
  return data.customers.find(c => c.email === email) || null;
}
// ---- Automatic customer portal account after a successful payment ----
// The payer's browser gets a one-time, 24-hour "set your password" token. It is sent in the URL #fragment (never logged by servers).
const SETUP_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const sha256 = text => crypto.createHash("sha256").update(text).digest("hex");
function provisionPortalFromPayment(key, { issueSetupToken = false } = {}) {
  try {
    const rec = readPayments()[key];
    if (!rec || !rec.customerEmail) return null;
    const email = String(rec.customerEmail).trim().toLowerCase();
    const data = readProjectData();
    let customer = data.customers.find(c => c.email === email);
    if (!customer) {
      customer = { name: rec.customerName || "QEVNIX Customer", email, salt: null, passwordHash: null, createdByOrder: key, createdAt: new Date().toISOString() };
      data.customers.push(customer);
    }
    if (!data.projects.some(p => p.paymentRef === key)) {
      const isSub = rec.type === "subscription";
      const total = isSub ? rec.amount : rec.totalAmount;
      const paid = rec.amount;
      data.projects.push({
        id: crypto.randomUUID(), customerEmail: email, paymentRef: key,
        title: String(rec.item || "QEVNIX service").replace(/ \((starting|monthly starting) price\)/, "").slice(0, 120),
        description: isSub ? `Monthly plan, ${paid} INR per month including GST.` : `Paid online: ${paid} INR of ${total} INR (including GST).`,
        status: isSub ? "In Progress" : "Pending",
        paymentStatus: isSub || rec.paymentOption !== "advance" ? "Fully Paid" : "Advance Paid",
        totalAmount: total, paidAmount: paid, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
      });
    }
    let setupToken = null;
    if (issueSetupToken && !customer.passwordHash && customer.createdByOrder === key) {
      setupToken = crypto.randomBytes(24).toString("hex");
      customer.setup = { tokenHash: sha256(setupToken), expires: Date.now() + SETUP_TOKEN_TTL_MS };
    }
    writeProjectData(data);
    return { email, hasPassword: Boolean(customer.passwordHash), setupToken };
  } catch (e) { console.error("Portal provisioning failed:", e.message); return null; }
}
const portalInfo = p => p && { email: p.email, hasPassword: p.hasPassword, setupToken: p.setupToken || undefined };

app.post("/api/customer/login", (req, res) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");
    const keys = [`ip:${req.ip}`, `ip-email:${req.ip}|${email}`];
    if (tooManyAttempts(keys[0], 20) || tooManyAttempts(keys[1], 5)) {
      return res.status(429).json({ error: "Too many sign-in attempts. Please try again in 15 minutes." });
    }
    const data = readProjectData();
    const customer = data.customers.find(c => c.email === email);
    if (!customer || !customer.passwordHash || password.length < 1) { recordFailure(keys); return res.status(401).json({ error: "Email or password is incorrect." }); }
    const actual = Buffer.from(hashPassword(password, customer.salt), "hex");
    const expected = Buffer.from(customer.passwordHash, "hex");
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) { recordFailure(keys); return res.status(401).json({ error: "Email or password is incorrect." }); }
    loginAttempts.delete(keys[1]);
    const token = crypto.randomBytes(32).toString("hex");
    projectSessions.set(token, { email, expires: Date.now() + SESSION_TTL_MS });
    res.json({ token, customer: { name: customer.name, email: customer.email } });
  } catch (e) { res.status(500).json({ error: "Could not sign in." }); }
});
// Authenticated customer billing lookup. Subscription IDs are discovered from server-side
// payment records, never accepted from the browser as proof of ownership.
app.get("/api/customer/billing", rateLimit("customer-billing", 30, 10 * 60 * 1000), async (req, res) => {
  try {
    const customer = customerFromRequest(req);
    if (!customer) return res.status(401).json({ error: "Please sign in again." });
    const records = Object.values(readPayments()).filter(r => r && r.type === "subscription" && String(r.customerEmail || "").toLowerCase() === customer.email);
    const subscriptions = [];
    for (const record of records) {
      const subscriptionId = String(record.subscriptionId || "");
      if (!ID_RE.test(subscriptionId)) continue;
      try {
        const sub = await razorpay.fetchSubscription(subscriptionId);
        const notes = sub.notes || {};
        if (notes.brand !== "QEVNIX" || String(notes.customer_email || "").toLowerCase() !== customer.email) continue;
        const invoiceResult = await razorpay.fetchSubscriptionInvoices(subscriptionId);
        const invoices = (invoiceResult.items || []).map(inv => ({
          id: inv.id,
          invoiceNumber: inv.invoice_number || inv.id,
          status: inv.status || "unknown",
          amount: Number(inv.amount || 0) / 100,
          currency: inv.currency || "INR",
          issuedAt: inv.issued_at || inv.date || null,
          paidAt: inv.paid_at || null,
          paymentId: inv.payment_id || null
        })).sort((a, b) => Number(b.issuedAt || 0) - Number(a.issuedAt || 0));
        const plan = products[notes.plan_code] || {};
        subscriptions.push({
          subscriptionId: sub.id,
          planCode: notes.plan_code || record.planCode || "",
          planName: plan.label || record.item || "QEVNIX Subscription",
          amount: Number(record.amount || plan.amount || 0),
          currency: "INR",
          status: sub.status || record.status || "unknown",
          nextChargeAt: sub.charge_at || null,
          currentStart: sub.current_start || null,
          currentEnd: sub.current_end || null,
          startAt: sub.start_at || null,
          paidCount: Number(sub.paid_count || 0),
          totalCount: Number(sub.total_count || 0),
          remainingCount: Number(sub.remaining_count || 0),
          invoices
        });
      } catch (err) {
        console.error("Customer billing lookup for subscription", subscriptionId, err.message);
      }
    }
    res.json({ customer: { name: customer.name, email: customer.email }, subscriptions, fetchedAt: new Date().toISOString() });
  } catch (e) {
    console.error("Customer billing lookup:", e.message);
    res.status(500).json({ error: "Could not load billing details. Please try again later." });
  }
});

// Authenticated unified payment history: one-time orders + subscription invoices.
// Ownership is derived only from the signed-in customer's server-side records and Razorpay notes.
app.get("/api/customer/payments", rateLimit("customer-payments", 30, 10 * 60 * 1000), async (req, res) => {
  try {
    const customer = customerFromRequest(req);
    if (!customer) return res.status(401).json({ error: "Please sign in again." });
    const email = String(customer.email || "").toLowerCase();
    const records = Object.values(readPayments()).filter(r => r && String(r.customerEmail || "").toLowerCase() === email);
    const payments = [];
    for (const record of records) {
      if (record.type === "order" && record.orderId) {
        try {
          const order = await razorpay.fetchOrder(record.orderId);
          if (!order.notes || order.notes.brand !== "QEVNIX" || String(order.notes.customer_email || "").toLowerCase() !== email) continue;
          let payment = null;
          if (record.paymentId) payment = await razorpay.fetchPayment(record.paymentId);
          else {
            const found = await razorpay.fetchOrderPayments(record.orderId);
            payment = (found.items || []).filter(x => x.order_id === record.orderId).sort((a,b) => Number(b.created_at || 0)-Number(a.created_at || 0))[0] || null;
          }
          const isPaid = Boolean(payment && payment.status === "captured") || order.status === "paid";
          payments.push({
            id: payment && payment.id || record.paymentId || record.orderId,
            orderId: record.orderId,
            type: "one_time",
            description: record.item || "QEVNIX website service",
            amount: Number(payment && payment.amount != null ? payment.amount : (record.amountPaid != null ? record.amountPaid * 100 : record.amount * 100)) / 100,
            currency: payment && payment.currency || record.currency || "INR",
            status: isPaid ? "paid" : (payment && payment.status || order.status || record.status || "pending"),
            method: payment && payment.method || record.method || null,
            paidAt: payment && payment.created_at || record.paidAt || null
          });
        } catch (err) { console.error("One-time payment history lookup:", record.orderId, err.message); }
      }
      if (record.type === "subscription" && record.subscriptionId && ID_RE.test(String(record.subscriptionId))) {
        try {
          const sub = await razorpay.fetchSubscription(record.subscriptionId);
          if (!sub.notes || sub.notes.brand !== "QEVNIX" || String(sub.notes.customer_email || "").toLowerCase() !== email) continue;
          const invResult = await razorpay.fetchSubscriptionInvoices(record.subscriptionId);
          for (const inv of (invResult.items || [])) {
            payments.push({ id: inv.payment_id || inv.id, invoiceId: inv.id, type: "subscription", description: record.item || "QEVNIX subscription", amount: Number(inv.amount || 0) / 100, currency: inv.currency || "INR", status: inv.status || "unknown", method: null, paidAt: inv.paid_at || inv.issued_at || inv.date || null });
          }
        } catch (err) { console.error("Subscription payment history lookup:", record.subscriptionId, err.message); }
      }
    }
    payments.sort((a,b) => Number(b.paidAt || 0) - Number(a.paidAt || 0));
    res.json({ customer: { name: customer.name, email: customer.email }, payments, fetchedAt: new Date().toISOString() });
  } catch (e) {
    console.error("Customer payment history:", e.message);
    res.status(500).json({ error: "Could not load payment history. Please try again later." });
  }
});

app.get("/api/customer/projects", (req, res) => {
  try {
    const customer = customerFromRequest(req);
    if (!customer) return res.status(401).json({ error: "Please sign in again." });
    const data = readProjectData();
    const projects = data.projects.filter(p => p.customerEmail === customer.email).map(({ id, title, description, status, paymentStatus, totalAmount, paidAmount, updatedAt }) => ({ id, title, description, status, paymentStatus, totalAmount, paidAmount, balanceAmount: Math.max(0, Number(totalAmount || 0) - Number(paidAmount || 0)), updatedAt }));
    res.json({ customer: { name: customer.name, email: customer.email }, projects });
  } catch (e) { res.status(500).json({ error: "Could not load projects." }); }
});
app.post("/api/customer/set-password", rateLimit("set-password", 10, 15 * 60 * 1000), (req, res) => {
  try {
    const token = String(req.body.token || ""), password = String(req.body.password || "");
    if (!/^[a-f0-9]{48}$/.test(token)) return res.status(400).json({ error: "This link is not valid. Please message QEVNIX on WhatsApp." });
    if (password.length < 8 || password.length > 100) return res.status(400).json({ error: "Password must be at least 8 characters." });
    const data = readProjectData(); const h = sha256(token);
    const customer = data.customers.find(c => c.setup && c.setup.tokenHash === h && c.setup.expires > Date.now() && !c.passwordHash);
    if (!customer) return res.status(400).json({ error: "This link has expired or was already used. Please message QEVNIX on WhatsApp and we will reset your access." });
    customer.salt = crypto.randomBytes(16).toString("hex");
    customer.passwordHash = hashPassword(password, customer.salt);
    delete customer.setup;
    writeProjectData(data);
    const session = crypto.randomBytes(32).toString("hex");
    projectSessions.set(session, { email: customer.email, expires: Date.now() + SESSION_TTL_MS });
    res.json({ token: session, customer: { name: customer.name, email: customer.email } });
  } catch (e) { console.error("Set password:", e.message); res.status(500).json({ error: "Could not save your password." }); }
});
app.post("/api/customer/logout", (req, res) => {
  const auth = String(req.headers.authorization || "");
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  projectSessions.delete(token);
  res.json({ loggedOut: true });
});
app.get("/api/admin/projects", (req, res) => {
  if (!projectAdminAuthorized(req)) return res.status(401).json({ error: "Admin access denied." });
  try { const data = readProjectData(); res.json({ customers: data.customers.map(c => ({ name: c.name, email: c.email })), projects: data.projects }); }
  catch (e) { res.status(500).json({ error: "Could not load project records." }); }
});
app.post("/api/admin/projects", (req, res) => {
  if (!projectAdminAuthorized(req)) return res.status(401).json({ error: "Admin access denied." });
  try {
    const name = String(req.body.customerName || "").trim().slice(0, 80);
    const email = String(req.body.customerEmail || "").trim().toLowerCase();
    const password = String(req.body.password || "");
    const title = String(req.body.title || "").trim().slice(0, 120);
    const description = String(req.body.description || "").trim().slice(0, 1000);
    const status = String(req.body.status || "Pending");
    const paymentStatus = String(req.body.paymentStatus || "Advance Due");
    const totalAmount = Number(req.body.totalAmount || 0);
    const paidAmount = Number(req.body.paidAmount || 0);
    if (name.length < 2 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 8 || title.length < 2 || !Number.isFinite(totalAmount) || totalAmount < 0 || !Number.isFinite(paidAmount) || paidAmount < 0 || paidAmount > totalAmount) return res.status(400).json({ error: "Enter valid customer details, a password of at least 8 characters, project title and payment amounts." });
    if (!["Pending", "In Progress", "Demo Ready", "Completed"].includes(status)) return res.status(400).json({ error: "Invalid project status." });
    if (!["Advance Due", "Advance Paid", "Balance Due", "Fully Paid"].includes(paymentStatus)) return res.status(400).json({ error: "Invalid payment status." });
    const data = readProjectData();
    let customer = data.customers.find(c => c.email === email);
    if (!customer) {
      const salt = crypto.randomBytes(16).toString("hex");
      customer = { name, email, salt, passwordHash: hashPassword(password, salt), createdAt: new Date().toISOString() };
      data.customers.push(customer);
    } else {
      customer.name = name;
      if (password) { const salt = crypto.randomBytes(16).toString("hex"); customer.salt = salt; customer.passwordHash = hashPassword(password, salt); }
    }
    const project = { id: crypto.randomUUID(), customerEmail: email, title, description, status, paymentStatus, totalAmount, paidAmount, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    data.projects.push(project); writeProjectData(data);
    res.status(201).json({ created: true, project, customer: { name, email }, message: "Customer login and project created." });
  } catch (e) { console.error("Create project:", e.message); res.status(500).json({ error: "Could not create project." }); }
});
app.patch("/api/admin/projects/:id", (req, res) => {
  if (!projectAdminAuthorized(req)) return res.status(401).json({ error: "Admin access denied." });
  try {
    const data = readProjectData(); const project = data.projects.find(p => p.id === req.params.id);
    if (!project) return res.status(404).json({ error: "Project not found." });
    const status = req.body.status || project.status; const paymentStatus = req.body.paymentStatus || project.paymentStatus;
    if (!["Pending", "In Progress", "Demo Ready", "Completed"].includes(status) || !["Advance Due", "Advance Paid", "Balance Due", "Fully Paid"].includes(paymentStatus)) return res.status(400).json({ error: "Invalid status." });
    project.status = status; project.paymentStatus = paymentStatus; project.updatedAt = new Date().toISOString();
    if (req.body.description !== undefined) project.description = String(req.body.description).slice(0, 1000);
    writeProjectData(data); res.json({ updated: true, project });
  } catch (e) { res.status(500).json({ error: "Could not update project." }); }
});

const planEnvName = code => `RAZORPAY_PLAN_${String(code).toUpperCase()}`;

// ---- One-time website package payment (Razorpay Orders) ----
// Amount and product are chosen on the server; the browser only sends a plan code.
app.post("/api/payments/create-order", rateLimit("create-order", 20, 10 * 60 * 1000), async (req, res) => {
  try {
    const item = products[req.body.planCode];
    if (!item || item.type !== "one_time") return res.status(400).json({ error: "Invalid website package." });
    const paymentOption = req.body.paymentOption === "advance" ? "advance" : "full";
    const gstAmount = money2(item.amount * GST_RATE / 100);
    const totalWithGst = money2(item.amount + gstAmount);
    const payableAmount = paymentOption === "advance" ? money2(totalWithGst * 50 / 100) : totalWithGst;
    const remainingAmount = money2(totalWithGst - payableAmount);
    const c = cleanCustomer(req.body);
    if (!c.ok) return res.status(400).json({ error: "Please enter a valid 10-digit phone number and email address." });
    const order = await razorpay.createOrder({
      amount: Math.round(payableAmount * 100), // paise
      currency: "INR",
      receipt: `qx_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`,
      notes: { brand: "QEVNIX", plan_code: req.body.planCode, payment_option: paymentOption, base_amount: String(item.amount), gst_rate: String(GST_RATE), gst_amount: String(gstAmount), total_amount: String(totalWithGst), customer_name: c.name, customer_email: c.email, customer_phone: c.phone }
    });
    upsertPayment(order.id, { type: "order", orderId: order.id, planCode: req.body.planCode, item: item.label, paymentOption, baseAmount: item.amount, gstRate: GST_RATE, gstAmount, amount: payableAmount, totalAmount: totalWithGst, remainingAmount, customerName: c.name, customerEmail: c.email, customerPhone: c.phone, status: "created", mode: paymentMode });
    res.json({
      orderId: order.id, amount: order.amount, currency: order.currency, keyId: process.env.RAZORPAY_KEY_ID,
      item: item.label, description: `${item.label} - ${paymentOption === "advance" ? "50% advance" : "full payment"} (including GST)` ,
      paymentOption, baseAmount: item.amount, gstRate: GST_RATE, gstAmount, totalAmount: totalWithGst, remainingAmount, mode: paymentMode,
      prefill: { name: c.name, email: c.email, contact: c.phone }
    });
  } catch (e) {
    console.error("Razorpay create order:", e.message);
    res.status(e.status || 500).json({ error: e.message || "Could not start the payment." });
  }
});

// After checkout succeeds in the browser, the server re-checks the signature AND asks Razorpay for the real status.
app.post("/api/payments/verify", rateLimit("verify", 40, 10 * 60 * 1000), async (req, res) => {
  try {
    const orderId = String(req.body.razorpay_order_id || ""), paymentId = String(req.body.razorpay_payment_id || ""), signature = String(req.body.razorpay_signature || "");
    if (!ID_RE.test(orderId) || !ID_RE.test(paymentId) || !signature) return res.status(400).json({ verified: false, error: "Missing payment details." });
    if (!rzp.verifyPaymentSignature({ orderId, paymentId, signature }, process.env.RAZORPAY_KEY_SECRET)) {
      return res.status(400).json({ verified: false, error: "Payment signature could not be verified. Please contact QEVNIX if money was debited." });
    }
    const [order, payment] = await Promise.all([razorpay.fetchOrder(orderId), razorpay.fetchPayment(paymentId)]);
    if (!order.notes || order.notes.brand !== "QEVNIX" || payment.order_id !== order.id) return res.status(400).json({ verified: false, error: "Payment does not match this order." });
    const paid = payment.status === "captured";
    upsertPayment(order.id, { status: paid ? "paid" : payment.status, paymentId, method: payment.method, amountPaid: payment.amount / 100, currency: payment.currency || "INR", paidAt: payment.created_at || null });
    const portal = paid ? provisionPortalFromPayment(order.id, { issueSetupToken: true }) : null;
    res.json({ verified: true, paid, paymentStatus: payment.status, orderId: order.id, paymentId, amount: payment.amount / 100, portal: portalInfo(portal) });
  } catch (e) {
    console.error("Razorpay verify:", e.message);
    res.status(e.status || 500).json({ verified: false, error: e.message || "Could not verify payment." });
  }
});

// Used by payment-return.html to show the current status of an order.
app.get("/api/payments/order/:orderId", rateLimit("order-status", 60, 10 * 60 * 1000), async (req, res) => {
  try {
    if (!ID_RE.test(req.params.orderId)) return res.status(400).json({ error: "Invalid order reference." });
    const order = await razorpay.fetchOrder(req.params.orderId);
    if (!order.notes || order.notes.brand !== "QEVNIX") return res.status(404).json({ error: "Order not found." });
    res.json({ orderId: order.id, orderStatus: order.status, amount: order.amount / 100, currency: order.currency, paid: order.status === "paid" });
  } catch (e) {
    console.error("Razorpay fetch order:", e.message);
    res.status(e.status || 500).json({ error: e.message || "Could not check payment." });
  }
});

// ---- Monthly subscriptions (Razorpay Subscriptions) ----
// Plans must exist in your Razorpay account first: run `node create-plans.js` once and paste the IDs into .env.
app.post("/api/subscriptions/create", rateLimit("sub-create", 20, 10 * 60 * 1000), async (req, res) => {
  try {
    const item = products[req.body.planCode];
    if (!item || item.type !== "subscription") return res.status(400).json({ error: "Invalid maintenance plan." });
    const c = cleanCustomer(req.body);
    if (!c.ok) return res.status(400).json({ error: "Please enter a valid 10-digit phone number and email address." });
    const planId = process.env[planEnvName(req.body.planCode)];
    if (!planId) return res.status(503).json({ error: "Monthly billing for this plan is not set up yet. Please contact QEVNIX on WhatsApp." });
    const sub = await razorpay.createSubscription({
      plan_id: planId, total_count: 120, quantity: 1, customer_notify: 1,
      notes: { brand: "QEVNIX", plan_code: req.body.planCode, customer_name: c.name, customer_email: c.email, customer_phone: c.phone, notice_period_days: "30" }
    });
    upsertPayment(sub.id, { type: "subscription", subscriptionId: sub.id, planCode: req.body.planCode, item: item.label, amount: item.amount, customerName: c.name, customerEmail: c.email, customerPhone: c.phone, status: sub.status, mode: paymentMode });
    res.json({
      subscriptionId: sub.id, keyId: process.env.RAZORPAY_KEY_ID, item: item.label, amount: item.amount,
      description: `${item.label} - monthly`, mode: paymentMode, prefill: { name: c.name, email: c.email, contact: c.phone }
    });
  } catch (e) {
    console.error("Razorpay create subscription:", e.message);
    res.status(e.status || 500).json({ error: e.message || "Could not create subscription.", hint: "Razorpay Subscriptions must be enabled on your account." });
  }
});

app.post("/api/subscriptions/verify", rateLimit("sub-verify", 40, 10 * 60 * 1000), async (req, res) => {
  try {
    const subscriptionId = String(req.body.razorpay_subscription_id || ""), paymentId = String(req.body.razorpay_payment_id || ""), signature = String(req.body.razorpay_signature || "");
    if (!ID_RE.test(subscriptionId) || !ID_RE.test(paymentId) || !signature) return res.status(400).json({ verified: false, error: "Missing subscription details." });
    const sub = await razorpay.fetchSubscription(subscriptionId); // use the ID Razorpay knows, not just what the browser sent
    if (!sub.notes || sub.notes.brand !== "QEVNIX") return res.status(400).json({ verified: false, error: "Subscription not recognised." });
    if (!rzp.verifySubscriptionSignature({ subscriptionId: sub.id, paymentId, signature }, process.env.RAZORPAY_KEY_SECRET)) {
      return res.status(400).json({ verified: false, error: "Signature could not be verified. Please contact QEVNIX." });
    }
    upsertPayment(sub.id, { status: sub.status, authPaymentId: paymentId });
    const portal = ["authenticated", "active"].includes(sub.status) ? provisionPortalFromPayment(sub.id, { issueSetupToken: true }) : null;
    res.json({ verified: true, subscriptionId: sub.id, status: sub.status, portal: portalInfo(portal) });
  } catch (e) {
    console.error("Razorpay verify subscription:", e.message);
    res.status(e.status || 500).json({ verified: false, error: e.message || "Could not verify subscription." });
  }
});

app.get("/api/subscriptions/:subscriptionId", rateLimit("sub-status", 60, 10 * 60 * 1000), async (req, res) => {
  try {
    if (!ID_RE.test(req.params.subscriptionId)) return res.status(400).json({ error: "Invalid subscription reference." });
    const sub = await razorpay.fetchSubscription(req.params.subscriptionId);
    if (!sub.notes || sub.notes.brand !== "QEVNIX") return res.status(404).json({ error: "Subscription not found." });
    res.json({ subscriptionId: sub.id, status: sub.status, paidCount: sub.paid_count, planCode: sub.notes.plan_code });
  } catch (e) {
    console.error("Razorpay fetch subscription:", e.message);
    res.status(e.status || 500).json({ error: e.message || "Could not fetch subscription." });
  }
});

// Cancellation requests are stored for admin review. This does NOT cancel a Razorpay subscription automatically.
const CANCELLATIONS_FILE = process.env.CANCELLATIONS_FILE || path.join(DATA_DIR, "cancellation-requests.json");
function readCancellationRequests() {
  try { const rows = JSON.parse(fs.readFileSync(CANCELLATIONS_FILE, "utf8")); return Array.isArray(rows) ? rows : []; }
  catch (e) { if (e.code === "ENOENT") return []; throw e; }
}
function writeCancellationRequests(rows) {
  fs.mkdirSync(path.dirname(CANCELLATIONS_FILE), { recursive: true });
  const tmp = CANCELLATIONS_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(rows, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, CANCELLATIONS_FILE);
}
app.post("/api/subscriptions/cancellation-request", rateLimit("cancel-req", 10, 60 * 60 * 1000), (req, res) => {
  try {
    const signedInCustomer = customerFromRequest(req);
    if (!signedInCustomer) return res.status(401).json({ error: "Please sign in to request cancellation." });
    const name = String(signedInCustomer.name || req.body.name || "").trim().slice(0, 80);
    const customerEmail = signedInCustomer.email;
    const subscriptionId = String(req.body.subscriptionId || "").trim().slice(0, 60);
    const reason = String(req.body.reason || "").trim().slice(0, 1000);
    if (name.length < 2 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail) || !ID_RE.test(subscriptionId)) {
      return res.status(400).json({ error: "Please enter your name, a valid registered email and a valid subscription ID." });
    }
    const ownedSubscription = Object.values(readPayments()).some(r => r && r.type === "subscription" && r.subscriptionId === subscriptionId && String(r.customerEmail || "").toLowerCase() === customerEmail);
    if (!ownedSubscription) return res.status(404).json({ error: "This subscription is not linked to your signed-in account." });
    const rows = readCancellationRequests();
    const duplicate = rows.find(r => r.subscriptionId === subscriptionId && r.customerEmail === customerEmail && r.status === "pending");
    if (duplicate) return res.status(200).json({ received: true, requestId: duplicate.id, message: "A pending cancellation request already exists for this subscription." });
    if (rows.length >= 10000) return res.status(429).json({ error: "Cancellation requests are temporarily unavailable. Please contact QEVNIX." });
    const request = { id: crypto.randomUUID(), name, customerEmail, subscriptionId, reason, status: "pending", noticePeriodDays: 30, createdAt: new Date().toISOString() };
    rows.push(request); writeCancellationRequests(rows);
    res.status(201).json({ received: true, requestId: request.id, message: "Your cancellation request has been saved for QEVNIX review. This does not cancel the subscription automatically." });
  } catch (e) { console.error("Cancellation request:", e.message); res.status(500).json({ error: "Could not save your request. Please contact QEVNIX." }); }
});
app.get("/api/admin/cancellation-requests", (req, res) => {
  if (!projectAdminAuthorized(req)) return res.status(401).json({ error: "Admin access denied." });
  try { res.json({ requests: readCancellationRequests().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))) }); }
  catch (e) { res.status(500).json({ error: "Could not load cancellation requests." }); }
});

// Admin: list recorded payments/subscriptions (send your ADMIN_PROJECT_TOKEN in the x-admin-token header).
app.get("/api/admin/payments", (req, res) => {
  if (!projectAdminAuthorized(req)) return res.status(401).json({ error: "Admin access denied." });
  try { res.json({ payments: Object.values(readPayments()).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))) }); }
  catch (e) { res.status(500).json({ error: "Could not load payments." }); }
});

// ---- Razorpay webhook: Dashboard > Settings > Webhooks. URL: https://YOUR-DOMAIN/api/razorpay/webhook ----
app.post("/api/razorpay/webhook", (req, res) => {
  try {
    const signature = req.headers["x-razorpay-signature"];
    const eventId = String(req.headers["x-razorpay-event-id"] || "");
    if (!process.env.RAZORPAY_WEBHOOK_SECRET) {
      console.error("Webhook received but RAZORPAY_WEBHOOK_SECRET is not configured.");
      return res.status(503).send("Webhook secret is not configured");
    }
    if (!rzp.verifyWebhookSignature(req.rawBody, signature, process.env.RAZORPAY_WEBHOOK_SECRET)) {
      return res.status(400).send("Invalid webhook signature");
    }
    if (hasWebhookEvent(eventId)) return res.json({ received: true, duplicate: true });

    const evt = req.body || {}; const pl = evt.payload || {};
    const pay = pl.payment && pl.payment.entity; const sub = pl.subscription && pl.subscription.entity;
    if (pay && /^payment\./.test(evt.event)) {
      const status = evt.event === "payment.captured" ? "paid" : (evt.event === "payment.failed" ? "failed" : pay.status);
      if (pay.order_id) upsertPayment(pay.order_id, { type: "order", orderId: pay.order_id, status, paymentId: pay.id, method: pay.method, amountPaid: pay.amount / 100, currency: pay.currency || "INR", paidAt: pay.created_at || null, lastWebhookEvent: evt.event });
      else if (pay.invoice_id || sub) upsertPayment(`pay:${pay.id}`, { type: "subscription_charge", paymentId: pay.id, status, amountPaid: pay.amount / 100, customerEmail: pay.email, lastWebhookEvent: evt.event });
    }
    if (pl.order && pl.order.entity && evt.event === "order.paid") upsertPayment(pl.order.entity.id, { status: "paid", lastWebhookEvent: evt.event });
    // Create the customer's portal account + project even if the browser was closed (no setup token here; admin can reset access).
    if (evt.event === "payment.captured" && pay && pay.order_id) provisionPortalFromPayment(pay.order_id);
    if (evt.event === "order.paid" && pl.order && pl.order.entity) provisionPortalFromPayment(pl.order.entity.id);
    if (sub && ["subscription.activated", "subscription.charged"].includes(evt.event)) provisionPortalFromPayment(sub.id);
    if (sub && /^subscription\./.test(evt.event)) {
      upsertPayment(sub.id, { type: "subscription", subscriptionId: sub.id, status: sub.status, paidCount: sub.paid_count, planCode: sub.notes && sub.notes.plan_code, lastEvent: evt.event });
    }
    rememberWebhookEvent(eventId); // remembered only after successful processing, so Razorpay retries are never lost
    res.json({ received: true });
  } catch (e) {
    console.error("Webhook error:", e.message);
    res.status(500).send("Webhook processing failed");
  }
});

app.listen(PORT, () => console.log(`QEVNIX server (Razorpay ${paymentMode} mode) running at http://localhost:${PORT}`));
