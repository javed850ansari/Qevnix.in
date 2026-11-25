AUTOMATIC CUSTOMER PORTAL LOGIN AFTER PAYMENT
- When a payment is confirmed, the server creates the customer's portal account (login email = the email typed at checkout)
  and a project entry (Advance Paid / Fully Paid; monthly plans appear as In Progress).
- The paying browser then sees "Create your portal password" (one-time link in the URL #fragment, valid 24 hours, single use).
  After saving, the customer is signed in and lands in the portal. Returning customers just sign in; new purchases add a project.
- If the customer closes the page before setting a password (or the link expires), the account still exists but has no password.
  Reset it from the admin projects page: create a project for the same email with a new password (this sets the password;
  you can ignore the extra project), then send the password to the customer on WhatsApp.
- The webhook also creates the account/project if the browser was closed, so no paid customer is missed.

FOLDER LAYOUT (changed for security)
- public/  = the website. Upload ONLY this folder to a static host (Netlify etc.).
- server/  = Node backend. Never upload it to a static host and never serve it publicly.
  The server now serves only public/, so server/projects.json, reviews.json and .env cannot be downloaded.
- Customer login: max 5 failed attempts per email / 20 per IP per 15 minutes; sessions expire after 8 hours.
- Admin and portal pages are marked noindex and blocked in robots.txt.
- Static hosts (Netlify Drop) cannot run server/. Pay buttons, reviews and the customer portal need the Node server.

LIVE SETUP: NETLIFY (website) + RENDER (backend) + HOSTINGER (domain qevnix.in)
- Website: upload ONLY the public/ folder to Netlify. Backend: deploy the whole project to Render, start command
  "node server/server.js" (root: this folder; build command: "cd server && npm install").
- Backend address: https://qevnix-website.onrender.com. public/config.js sends /api/... calls to this Render backend;
  localhost continues to use the local server. If your Render service URL changes, update public/config.js.
- Render env vars: RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET, RAZORPAY_PLAN_*, ADMIN_REVIEW_TOKEN,
  ADMIN_PROJECT_TOKEN, FRONTEND_ORIGIN=https://qevnix.netlify.app,https://qevnix.in,https://www.qevnix.in,
  PUBLIC_BASE_URL=https://qevnix-website.onrender.com, and file paths on persistent storage if configured.
- Hostinger DNS records: A  @  -> 75.2.60.5 (Netlify) | CNAME www -> your-site.netlify.app | CNAME api -> your-service.onrender.com
  Delete any old/parking A or CNAME records for @ and www first.
- Razorpay webhook URL: https://qevnix-website.onrender.com/api/razorpay/webhook

QEVNIX WEBSITE — RAZORPAY PAYMENTS

How payments work
- One-time packages: Razorpay Orders + Standard Checkout. The customer fills a small form (name, email, mobile,
  full or 50% advance). The SERVER chooses the amount; the server re-checks Razorpay's signature and asks
  Razorpay for the real payment status before showing "Payment successful".
- Monthly plans: Razorpay Subscriptions. Plans must exist in your Razorpay account (see step 4 below).
- Webhook (/api/razorpay/webhook) verifies the HMAC signature against the raw request body, safely ignores duplicate
  event deliveries, and records payment/order/subscription status updates in server/payments.json. View them (admin only):
  GET /api/admin/payments with header x-admin-token = ADMIN_PROJECT_TOKEN.
- Cancellation requests are only a request. You decide, apply your notice policy, then cancel in the Razorpay dashboard.

LOCAL TEST SETUP (Windows)
1. Open the qevnix-website/server folder, click the address bar, type cmd, press Enter.
2. Run: npm install
3. Copy .env.example and rename the copy to .env (not .env.txt). In the Razorpay dashboard switch to TEST MODE,
   open Account & Settings > API Keys > Generate Test Key, and paste Key ID and Key Secret into .env.
4. For monthly plans run once: node create-plans.js   then paste the 4 lines it prints into .env.
   (Subscriptions must be enabled on your Razorpay account. If it fails, contact Razorpay support to enable it.)
5. Run: npm start    then open http://localhost:4242
6. Test with Razorpay's test cards/UPI only. Open http://localhost:4242/api/health to check the setup.

GOING LIVE
- Complete Razorpay KYC and activation, generate LIVE keys, put them in the hosting dashboard's environment variables
  (never in files you upload), and re-run create-plans.js with live keys (plans are separate for test and live).
- In Razorpay Dashboard > Account & Settings > Webhooks, add the endpoint URL above. Set a webhook secret and copy
  the exact same value into RAZORPAY_WEBHOOK_SECRET in Render. This is separate from the API Key Secret.
- Subscribe to payment.captured, payment.failed, order.paid, subscription.activated, subscription.charged,
  subscription.pending, subscription.halted, subscription.cancelled and subscription.completed.
- In Render, set FRONTEND_ORIGIN to the actual frontend origins (Netlify URL and any mapped custom domains), and
  PUBLIC_BASE_URL to the Render backend URL. Use persistent storage for PAYMENTS_FILE and WEBHOOK_EVENTS_FILE;
  without it, records/deduplication history may be lost on redeploy/restart.
- Remove the footer line "Online payments are not active on this website yet." once payments are live.
- Do not promise automatic monthly debits until you have tested a subscription end to end in test mode.
- Never put the key secret in HTML, JS, Netlify settings for the frontend, or GitHub.

PRICES (set on the server in server/server.js, "products")
- Basic Website ₹1,999 | Business ₹3,999 | Premium ₹6,999
- Maintenance Basic ₹999/month | Standard ₹1,999/month | Premium ₹3,999/month
- Google Business Profile Setup ₹999 | Google Profile Management ₹999/month | Business Growth Package ₹5,999
If you change a price, also change it in create-plans.js and create NEW plans (Razorpay plans cannot be edited).

QEVNIX BUSINESS GROWTH SERVICES
- Google Business Profile Setup: ₹999–₹1,499 one-time (button starts at ₹999; confirm the final quote before payment).
- Google Profile Management: from ₹999/month.
- Website + Google Profile Business Growth Package: ₹5,999–₹9,999 one-time (button starts at ₹5,999).
Google decides Business Profile eligibility. Do not promise verification, rankings or profile approval.

PAY FULL OR 50% ADVANCE
For one-time packages the customer chooses full payment or 50% advance in the checkout form. The remaining amount is
payable to QEVNIX as agreed. The order notes record which option was chosen.

OTHER
- The website enquiry form opens WhatsApp; it does not save leads to a database.
- Replace placeholder domain URLs and verify all legal pages before production.


CUSTOMER REVIEW SYSTEM (STARTER)
- Customers can submit a name, 1-5 star rating and written review at reviews.html.
- New reviews remain pending and are not shown publicly until approved.
- Admin page: /admin-reviews.html. Enter ADMIN_REVIEW_TOKEN from your private server .env, then load submissions and approve/reject.
- Set ADMIN_REVIEW_TOKEN to a long random secret (at least 24 characters). Never put it in frontend files, GitHub, or share it with customers.
- Review data is stored in server/reviews.json by default. Hosting filesystems may be temporary; configure REVIEWS_FILE to a persistent disk path or migrate to a database before relying on reviews in production. Back up the file.
- This starter does not include customer login, verified-purchase checks, spam protection/rate limiting, or a full database. Do not claim reviews are verified purchases unless you add that verification.


CUSTOMER LOGIN & PROJECT TRACKING (STARTER)
-------------------------------------------
New pages:
- customer-portal.html: customer sign-in and private project dashboard
- admin-projects.html: private QEVNIX admin page to create customer accounts/projects and update statuses

Setup:
1. In server/.env, set ADMIN_PROJECT_TOKEN to a long random secret of at least 24 characters. Do not share it with customers or put it in frontend code.
2. Start the Node server. Open /admin-projects.html and enter the same token.
3. Create a customer login using their email and a temporary password (minimum 8 characters). Add project title, total amount, amount paid, project status and payment status.
4. Share /customer-portal.html, the customer's email and temporary password privately. Ask the customer to use a unique password.
5. Update project/payment statuses from the admin page; customers see only projects assigned to their email.

Important limitations before production:
- This is an initial starter, not a fully production-hardened client portal. Admin access uses a shared secret token; use HTTPS and keep it private.
- Project/customer records are stored in server/projects.json. Configure persistent disk/storage on your hosting provider and set PROJECTS_FILE to that persistent path, otherwise records may be lost on redeploy/restart depending on host. Back up this file securely.
- Login sessions are held in server memory and are cleared when the server restarts. Password reset, email verification, audit logs, rate limiting and multi-admin roles are not included.
- Project payment status is manually updated by the QEVNIX admin. It is NOT automatically linked to Razorpay payments. Check server/payments.json or the Razorpay dashboard before before marking any amount as paid.
- Do not store payment card, UPI PIN, bank passwords or other sensitive payment credentials.


DOMAIN, HOSTING AND CUSTOMER RESPONSIBILITIES
- Website development is a QEVNIX service. The customer pays QEVNIX according to the accepted quotation and payment milestones.
- By default, the customer buys and owns their domain directly through their registrar account.
- By default, the customer buys and manages their hosting directly through their hosting provider account.
- QEVNIX can help connect the domain, configure DNS and deploy the website within the agreed project scope.
- Domain, hosting, renewals, premium tools and third-party provider charges are separate from QEVNIX development and monthly maintenance fees unless a written quote explicitly includes them.
- Optional website maintenance is paid monthly to QEVNIX. It does not pay for domain or hosting renewals.
- If QEVNIX is asked to buy domain or hosting on the customer's behalf, get written agreement on cost, ownership, access and transfer before purchase.


RAZORPAY PAYMENT VERIFICATION + WEBHOOK SETUP
---------------------------------------------
- Browser checkout success is not treated as proof by itself. /api/payments/verify checks the Razorpay order signature,
  fetches the order and payment directly from Razorpay, and confirms the payment belongs to the QEVNIX order.
- Subscription callback verification is handled by /api/subscriptions/verify.
- Webhook raw-body signature verification is enabled by Express JSON parser capture (req.rawBody). Never change the
  webhook route to verify a re-serialized JSON body; Razorpay signs the exact raw request bytes.
- Add the webhook URL in the Razorpay dashboard and set RAZORPAY_WEBHOOK_SECRET in Render. Do not use
  RAZORPAY_KEY_SECRET as the webhook secret.
- For production, use a persistent Render disk or database for payment records and webhook event IDs.
- Test in Razorpay TEST MODE first. A ZIP/code update does not create dashboard webhooks, set Render variables,
  approve the account, or prove a live payment. Complete those dashboard steps and run end-to-end test payments.


CANCELLATION REQUESTS AND OPTIONAL PERSISTENT STORAGE
----------------------------------------------------
- The My Subscription cancellation form now submits to the backend and saves each request
  in cancellation-requests.json for admin review.
- Admin endpoint: GET /api/admin/cancellation-requests
  Send ADMIN_PROJECT_TOKEN in the x-admin-token header. Keep this token private.
- A cancellation request is NOT an automatic Razorpay cancellation. Review the request,
  apply the stated 30-day notice policy and process the cancellation in Razorpay yourself.
- Customer portal project login and project list are implemented separately; accounts/projects
  are provisioned after verified successful payments/webhook events. Admin can manage projects.
- On Render Free, do not buy a disk just for this now. Without DATA_DIR, data is stored in
  the service's local folder and may be lost on restart/redeploy. If you later attach a disk,
  set DATA_DIR=/var/data and redeploy. Back up/migrate existing JSON files before switching.
- My Subscription now uses the existing Customer Portal email/password login and session.
  GET /api/customer/billing discovers subscriptions from server-side payment records for the
  signed-in email, re-fetches each subscription from Razorpay, checks the QEVNIX brand and
  registered email in subscription notes, and fetches invoices from Razorpay.
- The customer page displays the Razorpay subscription status, scheduled charge_at date,
  billing cycle counts and invoice/payment history. Razorpay subscription status is shown as
  the AutoPay/subscription status; it is not a separate bank/UPI mandate enquiry.
- Cancellation requests now require a signed-in customer and a subscription ID already
  linked to that customer's server-side payment record. Requests remain admin-reviewed and
  are not automatically cancelled in Razorpay.
- Billing lookup requires valid Razorpay API credentials on the backend and an existing
  verified QEVNIX subscription record. One-time website orders do not appear as subscriptions.
  Historical subscriptions not recorded by this backend or lacking the expected QEVNIX notes
  are intentionally not exposed by this customer lookup.

CUSTOMER PAYMENT HISTORY
- The My Subscription page now has a separate My Payments section.
- It calls the authenticated GET /api/customer/payments endpoint.
- The endpoint uses the signed-in customer's email and server-side payment records, then verifies QEVNIX order/subscription notes with Razorpay before returning one-time orders and subscription invoices.
- One-time order payments are recorded by the payment verification endpoint and Razorpay payment.captured/order.paid webhooks. Subscription billing rows are read from Razorpay subscription invoices.
- Configure Razorpay webhooks for payment.captured, payment.failed, order.paid, subscription.activated, and subscription.charged so payment records stay current.
- This requires real matching payment records and a customer portal account. Existing historical transactions that were never recorded by this backend may not appear automatically.
- The new endpoint requires the same existing customer login session; it does not expose another customer's payment data.
