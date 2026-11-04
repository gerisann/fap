/* Hold-to-cheer: the button has to be held for HOLD_MS. It fills left to right in my team's colour while
   faceless puppet fans pop up from behind the match card and cheer: a couple first, then more, ~12 at the end.
   Letting go early cancels (the fans duck back). No library, no assets: the fans are small inline SVGs. */

const HOLD_MS = 5000;
const WAVES = [[0, 2], [1100, 4], [2500, 3], [3700, 3]]; // [ms after the press, fans that join]
// slots across the card (left %, back row?) in the order they fill up: the middle first, the edges last
const SLOTS = [[46, 0], [60, 0], [32, 0], [72, 1], [20, 1], [54, 1], [84, 0], [10, 0], [38, 1], [66, 1], [92, 1], [26, 0]];
const SKIN = ["#f1d3b3", "#e0ac7e", "#c68c5a", "#8d5a3b", "#5c3a24"];
const OTHERS = ["#f2f2f2", "#16181c", "#ffb020", "#3355ff", "#21a366", "#e63946", "#8e5bd8", "#ff7f50"];
const pick = a => a[Math.floor(Math.random() * a.length)];
const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

// one puppet: 56×72 box, the figure centred at x=22 (room on the right for a flag)
function fanSvg(kind, shirt, skin, team) {
  const arm = (x1, y1, x2, y2, cls) => `<g class="arm ${cls}"><line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${shirt}" stroke-width="5.5" stroke-linecap="round"/><circle cx="${x2}" cy="${y2}" r="3" fill="${skin}"/></g>`;
  const body = `<path d="M9 72 L11 44 Q22 36 33 44 L35 72 Z" fill="${shirt}"/><circle cx="22" cy="28" r="8.5" fill="${skin}"/>`;
  const stripes = (x, y, w, h) => { let s = ""; for (let i = 0; i < 6; i++) s += `<rect x="${x + i * w / 6}" y="${y}" width="${w / 6 + .3}" height="${h}" fill="${i % 2 ? "#fff" : team}"/>`; return s; };
  let extra = "";
  if (kind === "scarf") // both hands hold a striped scarf above the head
    extra = `<g class="lift">${arm(13, 45, 7, 14, "")}${arm(31, 45, 37, 14, "")}<g>${stripes(5, 9, 34, 6)}</g></g>`;
  else if (kind === "flag") // one hand waves a flag on a pole, the other pumps
    extra = `${arm(13, 45, 6, 24, "l")}<g class="arm r">${`<line x1="31" y1="45" x2="35" y2="22" stroke="${shirt}" stroke-width="5.5" stroke-linecap="round"/>`}<line x1="36" y1="34" x2="36" y2="2" stroke="#7c828b" stroke-width="1.6"/><path class="flagcloth" d="M36 3 L54 6 L54 18 L36 15 Z" fill="${team}"/><path d="M36 9 L54 12" stroke="#fff" stroke-width="2.5"/><circle cx="35" cy="22" r="3" fill="${skin}"/></g>`;
  else if (kind === "neck") // a scarf round the neck, both fists up
    extra = `${arm(13, 45, 6, 22, "l")}${arm(31, 45, 38, 22, "r")}<g>${stripes(13, 37, 18, 4)}</g>`;
  else extra = `${arm(13, 45, 5, 26, "l")}${arm(31, 45, 39, 26, "r")}`;
  return `<svg viewBox="0 0 56 72" aria-hidden="true">${body}${extra}</svg>`;
}

function crowd(card, team) {
  const root = document.createElement("div"); root.className = "crowd"; root.setAttribute("aria-hidden", "true");
  const r = card.getBoundingClientRect();
  // sits right behind the card: the fans' lower part stays hidden behind it, so they seem to climb out from behind
  Object.assign(root.style, { left: r.left + "px", width: r.width + "px", bottom: innerHeight - r.top - 14 + "px" });
  document.body.append(root);
  let n = 0;
  const add = k => {
    for (let i = 0; i < k && n < SLOTS.length; i++, n++) {
      const [x, back] = SLOTS[n], f = document.createElement("div");
      const kind = n % 4 === 1 ? "scarf" : n % 4 === 3 ? "flag" : n % 3 === 0 ? "neck" : "arms";
      const shirt = n < 2 || Math.random() < .45 ? team : pick(OTHERS);
      f.className = "fan" + (back ? " back" : "");
      f.style.cssText = `left:${x}%;--r0:${(x < 50 ? -1 : 1) * (25 + Math.random() * 20)}deg;--d:${(.42 + Math.random() * .25).toFixed(2)}s;--dl:-${(Math.random() * .5).toFixed(2)}s`;
      f.innerHTML = `<div class="fan-bob">${fanSvg(kind, shirt, pick(SKIN), team)}</div>`;
      root.append(f);
      requestAnimationFrame(() => requestAnimationFrame(() => f.classList.add("up")));
    }
  };
  return {
    add,
    wild: () => root.classList.add("wild"),
    leave: () => { root.classList.add("gone"); for (const f of root.children) f.classList.remove("up"); setTimeout(() => root.remove(), 500); },
  };
}

// btn: the cheer button, card: the match card; opts: { color(), text(c), canStart(), labels(), done() → Promise, track }
export function holdToCheer(btn, card, opts) {
  let t0 = 0, raf = 0, timers = [], fans = null, state = "idle"; // idle | holding | sending
  const lbl = text => { const s = document.createElement("span"); s.className = "mb-lbl"; s.textContent = text; btn.replaceChildren(s); };
  const stopFx = () => { cancelAnimationFrame(raf); timers.forEach(clearTimeout); timers = []; };

  function start() {
    if (state !== "idle" || btn.disabled || !opts.canStart()) return;
    // already cheered for this match: just the show, for as long as the button is held (no fill, nothing saved)
    const replay = !!opts.isDone?.();
    state = replay ? "replay" : "holding"; t0 = performance.now();
    const c = opts.color(); btn.style.setProperty("--mc", c); btn.style.setProperty("--mct", opts.text(c)); btn.style.setProperty("--p", 0);
    btn.classList.add(replay ? "full" : "holding"); lbl(opts.labels().hold); opts.onStart?.();
    if (!reduced()) {
      fans = crowd(card, c); for (const [ms, k] of WAVES) timers.push(setTimeout(() => fans?.add(k), ms));
      if (replay) timers.push(setTimeout(() => fans?.wild(), WAVES[WAVES.length - 1][0] + 600));
    }
    opts.track(replay ? "cheer_replay_start" : "cheer_hold_start");
    if (replay) return;
    const step = now => {
      const p = Math.min(1, (now - t0) / HOLD_MS); btn.style.setProperty("--p", p.toFixed(4));
      if (p >= 1) finish(); else raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
  }
  function cancel() {
    if (state === "replay") {
      state = "idle"; stopFx(); btn.classList.remove("full"); lbl(opts.labels().idle); fans?.leave(); fans = null;
      opts.track("cheer_replay_end", { held_ms: Math.round(performance.now() - t0) });
      return;
    }
    if (state !== "holding") return;
    state = "idle"; stopFx(); btn.classList.remove("holding"); btn.style.setProperty("--p", 0); lbl(opts.labels().idle);
    fans?.leave(); fans = null;
    const held = Math.round(performance.now() - t0);
    if (held < 700) opts.onShort?.(); // a plain tap: tell them to hold
    opts.track("cheer_hold_cancel", { held_ms: held });
  }
  async function finish() {
    state = "sending"; stopFx(); btn.classList.remove("holding"); btn.classList.add("full"); lbl(opts.labels().done);
    fans?.add(SLOTS.length); fans?.wild();
    let ok = true;
    try { await opts.done(); } catch (_) { ok = false; }
    // the crowd celebrates for a moment, then the button settles into its "cheering ✓" state
    setTimeout(() => { fans?.leave(); fans = null; btn.classList.remove("full"); state = "idle"; opts.settle(ok); }, ok ? 2400 : 600);
  }

  btn.addEventListener("pointerdown", e => { if (e.button !== 0) return; e.preventDefault(); try { btn.setPointerCapture(e.pointerId); } catch (_) {} start(); });
  for (const ev of ["pointerup", "pointercancel", "lostpointercapture"]) btn.addEventListener(ev, cancel);
  btn.addEventListener("contextmenu", e => e.preventDefault()); // a long press must not open the phone's menu
  btn.addEventListener("keydown", e => { if ((e.key === " " || e.key === "Enter") && !e.repeat) { e.preventDefault(); start(); } });
  btn.addEventListener("keyup", e => { if (e.key === " " || e.key === "Enter") cancel(); });
  return { cancel };
}
