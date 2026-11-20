// QEVNIX frontend -> Render backend API routing.
(function () {
  var host = location.hostname.toLowerCase();
  var local = ["localhost", "127.0.0.1"].indexOf(host) !== -1;
  var backend = "https://qevnix-website.onrender.com";
  window.QEVNIX_API_BASE = local ? "" : backend;
  var base = window.QEVNIX_API_BASE;
  if (!base) return;
  var original = window.fetch;
  window.fetch = function (input, init) {
    if (typeof input === "string" && input.indexOf("/api/") === 0) input = base + input;
    return original.call(this, input, init);
  };
})();
