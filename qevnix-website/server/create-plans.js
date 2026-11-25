// One-time setup: creates the monthly maintenance plans in YOUR Razorpay account and prints the
// plan IDs to paste into .env.   Usage (from the server folder):   node create-plans.js
// Uses the keys in .env (test keys create test plans; live keys create live plans).
require("dotenv").config();
const { createClient, isConfigured, modeOf } = require("./razorpay");
const PLANS = [
  { env: "RAZORPAY_PLAN_MAINTENANCE_BASIC", name: "QEVNIX Basic Maintenance", amount: 999 },
  { env: "RAZORPAY_PLAN_MAINTENANCE_STANDARD", name: "QEVNIX Standard Maintenance", amount: 1999 },
  { env: "RAZORPAY_PLAN_MAINTENANCE_PREMIUM", name: "QEVNIX Premium Maintenance", amount: 3999 },
  { env: "RAZORPAY_PLAN_GOOGLE_PROFILE_MANAGEMENT", name: "QEVNIX Google Profile Management", amount: 999 }
];
(async () => {
  const keyId = process.env.RAZORPAY_KEY_ID, keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!isConfigured(keyId, keySecret)) { console.error("Add RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET to .env first."); process.exit(1); }
  const rz = createClient({ keyId, keySecret });
  console.log(`Creating plans in ${modeOf(keyId).toUpperCase()} mode...\n`);
  for (const p of PLANS) {
    try {
      const plan = await rz.createPlan({
        period: "monthly", interval: 1,
        item: { name: p.name, description: "Monthly service plan", amount: p.amount * 100, currency: "INR" },
        notes: { brand: "QEVNIX" }
      });
      console.log(`${p.env}=${plan.id}`);
    } catch (e) { console.error(`FAILED ${p.name}: ${e.message}`); }
  }
  console.log("\nPaste the lines above into server/.env, then restart the server. Run this only ONCE per mode, or you will create duplicate plans.");
})();
