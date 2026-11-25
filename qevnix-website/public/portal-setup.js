// After a successful payment: lets the customer create a portal password (token arrives in the URL #fragment).
(function () {
  var params = new URLSearchParams(location.hash.replace(/^#/, ""));
  var token = params.get("setup"), email = params.get("email") || "";
  if (window.history && history.replaceState) history.replaceState(null, "", location.pathname + location.search); // remove token from the address bar
  var esc = function (t) { return String(t).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); };
  window.qxPortal = {
    show: function () {
      var host = document.getElementById("portalSetup");
      if (!host) return;
      if (!token) {
        host.innerHTML = '<div class="panel" style="margin-top:28px"><h2>Your customer portal</h2><p>Track your project in the portal. Sign in with the email you used for payment. If you cannot sign in, message us on WhatsApp and we will help.</p><a class="btn btn-outline" href="customer-portal.html">Open customer portal</a></div>';
        return;
      }
      host.innerHTML = '<form class="contact-form" id="setupForm" style="margin-top:28px" novalidate><h3>Create your portal password</h3>' +
        '<p class="qx-sub" style="color:#505c6b;margin-top:8px">Your portal login email: <b>' + esc(email) + '</b>. Choose a password to track your project.</p>' +
        '<label>Password (at least 8 characters)<input type="password" name="password" autocomplete="new-password" minlength="8" required></label>' +
        '<label>Confirm password<input type="password" name="confirm" autocomplete="new-password" required></label>' +
        '<p class="form-error" id="setupError" role="alert" hidden></p>' +
        '<button class="btn btn-primary form-submit" type="submit">Save password and open portal</button>' +
        '<small class="form-note">This link works once and expires in 24 hours. If it expires, message us on WhatsApp.</small></form>';
      var form = document.getElementById("setupForm"), err = document.getElementById("setupError");
      form.addEventListener("submit", function (e) {
        e.preventDefault();
        var pw = form.elements.password.value, cf = form.elements.confirm.value;
        var fail = function (m) { err.textContent = m; err.hidden = false; };
        if (pw.length < 8) return fail("Password must be at least 8 characters.");
        if (pw !== cf) return fail("The two passwords do not match.");
        err.hidden = true;
        var btn = form.querySelector("button"); btn.disabled = true; btn.textContent = "Saving…";
        fetch("/api/customer/set-password", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: token, password: pw }) })
          .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
          .then(function (x) {
            if (!x.ok) throw new Error(x.d.error || "Could not save your password.");
            try { sessionStorage.setItem("qevnix_customer_token", x.d.token); } catch (e) {}
            location.href = "customer-portal.html";
          })
          .catch(function (ex) { btn.disabled = false; btn.textContent = "Save password and open portal"; fail(ex.message); });
      });
    }
  };
})();
