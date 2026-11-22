// QEVNIX checkout: a proper form (no browser prompt boxes) + Razorpay Standard Checkout.
// The browser only sends a plan code and customer details. Amounts are decided on the server.
(() => {
  const buttons = document.querySelectorAll(".qx-pay");
  if (!buttons.length) return;
  const rupees = n => "₹" + Number(n).toLocaleString("en-IN", { maximumFractionDigits: 2 });
  let catalog = null, lastFocus = null, current = null;

  const modal = document.createElement("div");
  modal.className = "qx-modal"; modal.hidden = true;
  modal.innerHTML = `
    <div class="qx-backdrop" data-close></div>
    <div class="qx-dialog" role="dialog" aria-modal="true" aria-labelledby="qxTitle">
      <button class="qx-x" type="button" aria-label="Close" data-close>&times;</button>
      <h3 id="qxTitle"></h3>
      <p class="qx-sub" id="qxSub"></p>
      <p class="qx-test" id="qxTest" hidden>Test mode: no real money is charged.</p>
      <form id="qxForm" novalidate>
        <label>Your name<input name="name" autocomplete="name" required></label>
        <label>Email<input name="email" type="email" autocomplete="email" required></label>
        <label>Mobile number<input name="phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="10-digit number" required></label>
        <fieldset class="qx-options" id="qxOptions" hidden>
          <legend>How would you like to pay?</legend>
          <label class="qx-radio"><input type="radio" name="option" value="full" checked><span><b>Pay in full</b><small id="qxFull"></small></span></label>
          <label class="qx-radio"><input type="radio" name="option" value="advance"><span><b>Pay 50% advance</b><small id="qxAdvance"></small></span></label>
        </fieldset>
        <p class="form-error" id="qxError" role="alert" hidden></p>
        <button class="qx-submit" type="submit" id="qxSubmit">Continue to secure payment</button>
        <small class="form-note">Payments are processed securely by Razorpay. See our <a href="terms.html">Terms</a> and <a href="refund-policy.html">Refund Policy</a>.</small>
      </form>
    </div>`;
  document.body.appendChild(modal);
  const $ = id => modal.querySelector(id);
  const form = $("#qxForm"), err = $("#qxError"), submit = $("#qxSubmit");

  const showError = msg => { err.textContent = msg; err.hidden = !msg; };
  const busy = (on, label) => { submit.disabled = on; submit.textContent = on ? label : "Continue to secure payment"; };
  const open = async button => {
    lastFocus = button;
    const code = button.dataset.planCode, type = button.dataset.paymentType;
    if (!catalog) {
      try { catalog = (await (await fetch("/api/products")).json()).products; } catch (e) { catalog = []; }
    }
    const item = catalog.find(p => p.code === code);
    current = { code, type, amount: item && item.amount };
    $("#qxTitle").textContent = item ? item.label.replace(/ \((starting|monthly starting) price\)/, "") : "QEVNIX payment";
    const isSub = type === "subscription";
    $("#qxSub").textContent = isSub
      ? (item ? `${rupees(item.amount)} per month including GST, billed monthly. ` : "Billed monthly. ") + "Cancellation terms are in our Terms and Refund Policy."
      : (item ? `Package price: ${rupees(item.amount)} + GST (${item.gstRate}%): ${rupees(item.gstAmount)}. Total: ${rupees(item.totalWithGst)}.` : "");
    $("#qxOptions").hidden = isSub;
    if (!isSub && item) { $("#qxFull").textContent = `Pay ${rupees(item.totalWithGst)} (including GST)`; $("#qxAdvance").textContent = `${rupees(item.totalWithGst / 2)} now (50% including GST), balance later`; }
    showError(""); busy(false);
    modal.hidden = false; document.body.classList.add("qx-lock");
    form.elements.name.focus();
  };
  const close = () => { modal.hidden = true; document.body.classList.remove("qx-lock"); if (lastFocus) lastFocus.focus(); };
  modal.addEventListener("click", e => { if (e.target.hasAttribute("data-close")) close(); });
  document.addEventListener("keydown", e => { if (e.key === "Escape" && !modal.hidden) close(); });
  buttons.forEach(b => b.addEventListener("click", () => open(b)));

  async function post(url, body) {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || "Something went wrong. Please try again.");
    return d;
  }

  form.addEventListener("submit", async e => {
    e.preventDefault(); showError("");
    const name = form.elements.name.value.trim(), email = form.elements.email.value.trim(), phone = form.elements.phone.value.replace(/\D/g, "").slice(-10);
    if (name.length < 2) return showError("Please enter your name.");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return showError("Please enter a valid email address.");
    if (phone.length !== 10) return showError("Please enter a valid 10-digit mobile number.");
    if (!window.Razorpay) return showError("The payment window could not load. Check your internet connection and try again.");
    const isSub = current.type === "subscription";
    busy(true, "Please wait…");
    try {
      const d = await post(isSub ? "/api/subscriptions/create" : "/api/payments/create-order", {
        planCode: current.code,
        paymentOption: (form.elements.option && form.elements.option.value) || "full",
        customer: { name, email, phone }
      });
      if (d.mode === "test") $("#qxTest").hidden = false;
      const options = {
        key: d.keyId, name: "QEVNIX", description: d.description,
        prefill: d.prefill, theme: { color: "#152033" },
        modal: { ondismiss: () => busy(false) },
        handler: async resp => {
          busy(true, "Confirming payment…");
          try {
            if (isSub) {
              const v = await post("/api/subscriptions/verify", resp);
              location.href = "subscription-return.html?subscription_id=" + encodeURIComponent(v.subscriptionId) + (v.portal && v.portal.setupToken ? "#setup=" + v.portal.setupToken + "&email=" + encodeURIComponent(v.portal.email) : "");
            } else {
              const v = await post("/api/payments/verify", resp);
              location.href = "payment-return.html?order_id=" + encodeURIComponent(v.orderId) + (v.portal && v.portal.setupToken ? "#setup=" + v.portal.setupToken + "&email=" + encodeURIComponent(v.portal.email) : "");
            }
          } catch (ex) {
            busy(false);
            showError(ex.message + " If money was debited, please message us on WhatsApp with your payment ID: " + (resp.razorpay_payment_id || ""));
          }
        }
      };
      if (isSub) options.subscription_id = d.subscriptionId;
      else { options.order_id = d.orderId; options.amount = d.amount; options.currency = d.currency; }
      const rzp = new window.Razorpay(options);
      rzp.on("payment.failed", r => { busy(false); showError((r.error && r.error.description) || "Payment failed. Please try again."); });
      rzp.open();
    } catch (ex) { busy(false); showError(ex.message); }
  });
})();
