// QEVNIX frontend -> Render backend API routing.
(function () {
  var host = location.hostname.toLowerCase();
  var local = host === "localhost" || host === "127.0.0.1";
  var BACKEND = "https://qevnix-website.onrender.com";
  var base = local ? "" : BACKEND;
  window.QEVNIX_API_BASE = base;
  if (!base || !window.fetch) return;

  var originalFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    try {
      if (typeof input === "string" && input.indexOf("/api/") === 0) {
        input = base + input;
      } else if (input instanceof URL && input.pathname.indexOf("/api/") === 0) {
        input = new URL(input.pathname + input.search + input.hash, base);
      }
    } catch (e) {
      // Leave non-API requests unchanged.
    }
    return originalFetch(input, init);
  };
})();
