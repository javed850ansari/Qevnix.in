// QEVNIX frontend -> backend API routing.
// ONE SWITCH: BACKEND below.
//  - Website on Netlify, backend on Render (current setup): keep the Render address.
//  - Website AND backend on one Hostinger Node app: set BACKEND = "" (same address).
(function () {
  var host = location.hostname.toLowerCase();
  var local = ["localhost", "127.0.0.1"].indexOf(host) !== -1;
  var BACKEND = "https://qevnix-website.onrender.com";
  var backend = BACKEND;
  window.QEVNIX_API_BASE = local ? "" : backend;
  var base = window.QEVNIX_API_BASE;
  if (!base) return;
  var original = window.fetch;
  window.fetch = function (input, init) {
    if (typeof input === "string" && input.indexOf("/api/") === 0) input = base + input;
    return original.call(this, input, init);
  };
})();
