// IMPORTANT: Replace this number with your WhatsApp number, including country code.
// Example for India: 919876543210 (do not include + or spaces).
const WHATSAPP_NUMBER = "919661985400";

const yearEl = document.getElementById("year");
if (yearEl) yearEl.textContent = new Date().getFullYear();

// Mobile menu
const menuButton = document.querySelector(".menu-toggle");
const nav = document.querySelector(".nav");
if (menuButton && nav) {
  const setMenu = open => {
    nav.classList.toggle("open", open);
    menuButton.setAttribute("aria-expanded", String(open));
    menuButton.textContent = open ? "Close" : "Menu";
  };
  menuButton.addEventListener("click", () => setMenu(!nav.classList.contains("open")));
  nav.querySelectorAll("a").forEach(a => a.addEventListener("click", () => setMenu(false)));
  document.addEventListener("keydown", e => { if (e.key === "Escape") setMenu(false); });
}

// Pre-select the plan in the enquiry form when a plan button is clicked
document.querySelectorAll("[data-plan]").forEach(link => {
  link.addEventListener("click", () => {
    const select = document.querySelector('select[name="plan"]');
    if (!select) return;
    const match = [...select.options].find(o => o.text === link.dataset.plan);
    if (match) select.value = match.value || match.text;
  });
});

// Enquiry form -> WhatsApp
const form = document.getElementById("leadForm");
if (form) {
  const error = document.getElementById("formError");
  form.addEventListener("submit", event => {
    event.preventDefault();
    const data = new FormData(form);
    const missing = ["name", "business", "type", "phone"].filter(k => !String(data.get(k) || "").trim());
    const digits = String(data.get("phone") || "").replace(/\D/g, "");
    let msg = "";
    if (missing.length) msg = "Please fill in your name, business name, business type and phone number.";
    else if (digits.length < 10) msg = "Please enter a valid phone number (at least 10 digits).";
    if (error) { error.hidden = !msg; error.textContent = msg; }
    if (msg) return;
    if (!WHATSAPP_NUMBER) { alert("WhatsApp number is not configured yet."); return; }
    const text = [
      "Hello QEVNIX! I want to enquire about your website services.",
      "",
      `Name: ${data.get("name")}`,
      `Shop / Business: ${data.get("business")}`,
      `Business type: ${data.get("type")}`,
      `Requirement: ${data.get("plan")}`,
      `Phone: ${data.get("phone")}`
    ].join("\n");
    window.open(`https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(text)}`, "_blank", "noopener");
  });
}

// Gentle scroll-reveal (skipped for visitors who prefer reduced motion)
(function () {
  if (!("IntersectionObserver" in window) || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  var items = document.querySelectorAll(".section-head,.svc,.plan,.step,.pay,.work-grid article,.why,.about-copy,.panel,.cta-band");
  if (!items.length) return;
  document.documentElement.classList.add("js-reveal");
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); } });
  }, { threshold: 0.12, rootMargin: "0px 0px -40px 0px" });
  items.forEach(function (el) { el.classList.add("reveal"); io.observe(el); });
})();
