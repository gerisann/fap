/* A short guided tour after the welcome: one highlighted spot at a time, with Next / Skip.
   Steps come from main.js: { el: () => selector, text: i18n key, before?: () => void }.
   A step whose element is not on screen (hidden, zero size) is skipped. */

// safe-area inset in px (status bar / home indicator when installed): custom properties keep env() unresolved, a probe does not
const inset = side => {
  const p = document.createElement("div"); p.style.cssText = `position:fixed;visibility:hidden;padding-${side}:env(safe-area-inset-${side},0px)`;
  document.body.append(p); const v = parseFloat(getComputedStyle(p).getPropertyValue("padding-" + side)) || 0; p.remove(); return v;
};
const visible = el => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";

export function runTour(steps, { t, track }) {
  const root = document.createElement("div"); root.className = "tour";
  root.innerHTML = `<div class="tour-hole"></div><div class="tour-tip" role="dialog" aria-modal="true" aria-live="polite">
    <p class="tour-text"></p><div class="tour-foot"><span class="tour-n"></span><button class="textbtn tour-skip"></button><button class="save sm tour-next"></button></div></div>`;
  document.body.append(root);
  const hole = root.querySelector(".tour-hole"), tip = root.querySelector(".tour-tip");
  const next = root.querySelector(".tour-next"), skip = root.querySelector(".tour-skip");
  let i = -1, target = null, timer = 0;
  const safe = { top: inset("top"), bottom: inset("bottom") };

  function place() {
    if (!target) return;
    const r = target.getBoundingClientRect(), pad = 6, vw = innerWidth, vh = innerHeight;
    Object.assign(hole.style, { left: r.left - pad + "px", top: r.top - pad + "px", width: r.width + 2 * pad + "px", height: r.height + 2 * pad + "px" });
    const w = Math.min(320, vw - 32), h = tip.offsetHeight, gap = 14;
    const lo = 16 + safe.top, hi = vh - 16 - safe.bottom; // clear of the status bar / home indicator
    // below the spot if it fits, else above, else over the spot's lower part; always on screen
    const top = r.bottom + gap + h <= hi ? r.bottom + gap : r.top - gap - h >= lo ? r.top - gap - h : Math.max(lo, hi - h);
    const left = Math.min(Math.max(16, r.left + r.width / 2 - w / 2), vw - w - 16);
    Object.assign(tip.style, { width: w + "px", left: left + "px", top: top + "px" });
  }
  function show(k) {
    for (; k < steps.length; k++) {
      steps[k].before?.();
      const el = document.querySelector(steps[k].el());
      if (visible(el)) { i = k; target = el; break; }
    }
    if (k >= steps.length) return end(true);
    target.scrollIntoView({ block: "nearest" });
    tip.querySelector(".tour-text").textContent = t(steps[i].text);
    root.querySelector(".tour-n").textContent = `${i + 1}/${steps.length}`;
    next.textContent = t(i === steps.length - 1 ? "tourDone" : "tourNext");
    skip.textContent = t("tourSkip"); skip.hidden = i === steps.length - 1;
    // the step may open a panel first: measure once its transition has settled
    place(); clearTimeout(timer); timer = setTimeout(place, 320);
    next.focus();
  }
  function end(done) {
    clearTimeout(timer); root.remove(); removeEventListener("resize", place); document.removeEventListener("keydown", key);
    track(done ? "tour_done" : "tour_skip", { step: i + 1 });
  }
  const key = e => { if (e.key === "Escape") end(false); else if (e.key === "ArrowRight" || e.key === "Enter") { e.preventDefault(); show(i + 1); } };
  next.onclick = () => show(i + 1);
  skip.onclick = () => end(false);
  addEventListener("resize", place); document.addEventListener("keydown", key);
  track("tour_start");
  show(0);
}
