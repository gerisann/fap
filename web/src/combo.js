/* Debounced async combobox: type → search(q, signal) → list → pick. Keyboard: ↑ ↓ Enter Esc. */
export function asyncCombo(input, list, { search, onPick, onInput, minLen = 2, delay = 250 }) {
  let items = [], idx = 0, timer = 0, ctrl = null;
  const close = () => { list.hidden = true; input.setAttribute("aria-expanded", "false"); };
  const mark = () => [...list.children].forEach((li, i) => li.setAttribute("aria-selected", String(i === idx)));
  function render() {
    list.replaceChildren();
    items.forEach((it, i) => {
      const li = document.createElement("li"); li.setAttribute("role", "option");
      const s = document.createElement("span"); s.textContent = it.name;
      const sm = document.createElement("small"); sm.textContent = it.sub || "";
      li.append(s, sm); li.onmousedown = e => { e.preventDefault(); pick(i); }; list.append(li);
    });
    mark(); list.hidden = !items.length; input.setAttribute("aria-expanded", String(!!items.length));
  }
  function pick(i) { const it = items[i]; if (!it) return; input.value = it.name; close(); onPick(it); }
  input.addEventListener("input", () => {
    clearTimeout(timer); ctrl?.abort(); onInput?.();
    const q = input.value.trim();
    if (q.length < minLen) { items = []; close(); return; }
    timer = setTimeout(async () => {
      ctrl = new AbortController();
      try { items = await search(q, ctrl.signal); idx = 0; render(); }
      catch (e) { if (e.name !== "AbortError") { items = []; close(); } }
    }, delay);
  });
  input.addEventListener("keydown", e => {
    if (list.hidden || !items.length) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); idx = (idx + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length; mark(); }
    else if (e.key === "Enter") { e.preventDefault(); pick(idx); }
    else if (e.key === "Escape") close();
  });
  input.addEventListener("blur", () => setTimeout(close, 120));
  return { clear() { items = []; input.value = ""; close(); } };
}
