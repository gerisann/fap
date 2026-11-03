/* One tracking entry point. Everything goes to window.dataLayer; GTM (when configured) routes it to GA4,
   Clarity etc. Consent Mode v2: analytics is denied until the visitor accepts. Ads are never enabled. */

const GTM_ID = import.meta.env.VITE_GTM_ID;
const KEY = "tm.consent";
// Never let location or identity reach analytics, whatever a caller passes.
const FORBIDDEN = /^(lat|lng|lon|latitude|longitude|coords?|center|uid|user_?id|email|name)$/i;

window.dataLayer = window.dataLayer || [];
function gtag() { window.dataLayer.push(arguments); }

export function consent() { try { const v = localStorage.getItem(KEY); return v === "granted" || v === "denied" ? v : null; } catch (_) { return null; } }

gtag("consent", "default", {
  ad_storage: "denied", ad_user_data: "denied", ad_personalization: "denied",
  analytics_storage: consent() === "granted" ? "granted" : "denied",
  functionality_storage: "granted", security_storage: "granted", wait_for_update: 500,
});

export function setConsent(v) {
  try { localStorage.setItem(KEY, v); } catch (_) {}
  gtag("consent", "update", { analytics_storage: v });
  window.dataLayer.push({ event: "consent_update", consent_analytics: v });
}

export function track(event, params = {}) {
  const clean = {};
  for (const k in params) if (!FORBIDDEN.test(k) && params[k] !== undefined) clean[k] = params[k];
  window.dataLayer.push({ event, ...clean });
  if (import.meta.env.DEV) console.debug("[track]", event, clean);
}

export function initAnalytics(ctx) {
  window.dataLayer.push({ event: "app_init", ...ctx });
  if (GTM_ID) {
    window.dataLayer.push({ "gtm.start": Date.now(), event: "gtm.js" });
    const s = document.createElement("script");
    s.async = true; s.src = "https://www.googletagmanager.com/gtm.js?id=" + encodeURIComponent(GTM_ID);
    document.head.append(s);
  }
  addEventListener("error", e => track("js_error", { message: String(e.message).slice(0, 120), source: String(e.filename || "").split("/").pop() }));
  addEventListener("unhandledrejection", e => track("js_error", { message: String(e.reason?.message || e.reason).slice(0, 120), source: "promise" }));
}
