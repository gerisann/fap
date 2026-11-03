import hu from "./locales/hu.js";
import en from "./locales/en.js";
import es from "./locales/es.js";

const DICTS = { hu, en, es };
export const LANGS = Object.keys(DICTS);
const KEY = "tm.lang";

function detect() {
  const q = new URLSearchParams(location.search).get("lang");
  if (q && DICTS[q]) return q;
  try { const v = localStorage.getItem(KEY); if (DICTS[v]) return v; } catch (_) {}
  for (const l of navigator.languages || [navigator.language]) { const b = String(l).slice(0, 2).toLowerCase(); if (DICTS[b]) return b; }
  return "en";
}

export let lang = detect();
let nf = new Intl.NumberFormat(DICTS[lang].locale);

export function t(key, vars) {
  let s = DICTS[lang][key] ?? DICTS.en[key] ?? key;
  if (vars) for (const k in vars) s = s.replaceAll("{" + k + "}", vars[k]);
  return s;
}
export const num = n => nf.format(n);
export const locale = () => DICTS[lang].locale;

/* data-i18n="key" sets textContent; data-i18n-attr="placeholder:key;aria-label:key" sets attributes */
export function applyDom(root = document) {
  document.documentElement.lang = lang;
  for (const el of root.querySelectorAll("[data-i18n]")) el.textContent = t(el.dataset.i18n);
  for (const el of root.querySelectorAll("[data-i18n-attr]"))
    for (const pair of el.dataset.i18nAttr.split(";")) { const [a, k] = pair.split(":"); el.setAttribute(a, t(k)); }
  document.querySelector('meta[name="description"]')?.setAttribute("content", t("description"));
}

const listeners = new Set();
export const onLangChange = fn => listeners.add(fn);
export function setLang(l) {
  if (!DICTS[l] || l === lang) return;
  lang = l; nf = new Intl.NumberFormat(DICTS[l].locale);
  try { localStorage.setItem(KEY, l); } catch (_) {}
  applyDom();
  for (const fn of listeners) fn(l);
}
