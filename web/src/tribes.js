/* Tribes: a team + city community with a feed. Map badges, the board list, and the tribe sheet.
   All access rules live in firestore.rules; the checks here only give friendlier messages first. */

import { isProfane, isBadName } from "./profanity.js";
import { matchesOf } from "./fixtures.js";

const $ = s => document.querySelector(s);
const CHECKIN_MS = 72 * 3600 * 1000;

// same format as validNick() in firestore.rules
export const validUsername = n => typeof n === "string" && /^[A-Za-z0-9_-]{3,20}$/.test(n) && !isBadName(n);
export const usernameProblem = n => !/^[A-Za-z0-9_-]{3,20}$/.test(n) ? "nickInvalid" : isBadName(n) ? "nickBad" : null;

// same ~50 km box as close() in firestore.rules, so the UI and the rules agree
export function nearBox(aLat, aLng, bLat, bLng) {
  const dLat = Math.abs(aLat - bLat), dLng = Math.abs(aLng - bLng), absLat = Math.abs(bLat);
  const lim = absLat < 35 ? 0.55 : absLat < 50 ? 0.7 : absLat < 60 ? 0.9 : 1.3;
  return dLat <= 0.45 && (dLng <= lim || dLng >= 360 - lim);
}

export function initTribes(ctx) {
  const { map, maplibregl, t, num, track } = ctx;
  let tribes = [], markers = new Map(), visible = false;
  let open = null, member = null, profile = null, presence = null, profileLoaded = false;
  let unsubPosts = null, unsubMember = null, pendingOpen = null, afterNick = null;
  const replyWatch = new Map(); // pid -> unsubscribe
  const sheet = $("#tribeSheet"), feed = $("#tsFeed");

  const m = location.pathname.match(/^\/t\/([^/]+)/);
  if (m) pendingOpen = decodeURIComponent(m[1]);
  // personal invite link: /t/<tid>?ref=<inviter uid>. Remember it for this tribe, then drop it from the URL.
  const REF = "tm.ref";
  const params = new URLSearchParams(location.search);
  if (m && params.get("ref")) {
    try { sessionStorage.setItem(REF, JSON.stringify({ tid: pendingOpen, ref: params.get("ref") })); } catch (_) {}
    params.delete("ref"); history.replaceState(null, "", location.pathname + (params.size ? "?" + params : ""));
    track("invite_open");
  }
  const refFor = tid => { try { const r = JSON.parse(sessionStorage.getItem(REF) || "null"); return r?.tid === tid ? r.ref : null; } catch (_) { return null; } };

  /* labels: custom name (or the team), the team as a tag, members + founding month */
  const titleOf = tr => tr.name || tr.team;
  const membersText = n => t(n === 1 ? "membersOne" : "membersOther", { n: num(n) });
  const foundedText = tr => { const ms = tr.createdAt?.toMillis?.(); return ms ? t("founded", { date: new Intl.DateTimeFormat(ctx.locale(), { year: "numeric", month: "short" }).format(ms) }) : ""; };
  // district tribes read "XIII. kerület, Budapest" / "Islington, London"
  const placeOf = tr => tr.district ? tr.district + ", " + tr.city : tr.city;
  const subOf = tr => [placeOf(tr), membersText(tr.memberCount), foundedText(tr)].filter(Boolean).join(" · ");
  function teamTag(team) { const s = document.createElement("span"); s.className = "team-tag"; s.textContent = team; return s; }

  /* ---------- data ---------- */
  function setBackend(fb) {
    fb.watchTribes(list => {
      tribes = list; render(); ctx.onTribes?.();
      if (open) { const fresh = list.find(x => x.id === open.id); if (fresh) { open = fresh; paintMembership(); } }
      if (pendingOpen) { const id = pendingOpen; pendingOpen = null; openTribe(id, "link"); } },
      e => track("store_error", { code: e.code || "unknown", source: "tribes" }));
  }
  async function onUser(u) {
    profile = null; presence = null; profileLoaded = false;
    if (u) { try { [profile, presence] = await Promise.all([ctx.backend().getProfile(), ctx.backend().getPresence()]); } catch (_) {} profileLoaded = true; }
    if (open) openTribe(open.id, "refresh");
  }
  const freshPresence = () => presence && Date.now() - presence.ts < CHECKIN_MS ? presence : null;
  function nearReason(tr) {
    const pin = ctx.myPin(), here = freshPresence();
    if (pin && nearBox(pin.lat, pin.lng, tr.lat, tr.lng)) return "pin";
    if (here && nearBox(here.lat, here.lng, tr.lat, tr.lng)) return "presence";
    return null;
  }

  /* ---------- map badges + board list ---------- */
  // badges only from region level (zoomed out they cover whole countries), the meta line only from city level
  const TRIBE_ZOOM = 7, TRIBE_ZOOM_FULL = 10;
  const band = z => z < TRIBE_ZOOM ? 0 : z < TRIBE_ZOOM_FULL ? 1 : 2;
  let zoomBand = null;
  map.on("zoomend", () => { if (visible && band(map.getZoom()) !== zoomBand) render(); });
  // the tribe search: accent-insensitive, over name, team, city and district
  const fold = s => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  let tribeQuery = "";
  const matches = tr => !tribeQuery || fold([tr.name, tr.team, tr.city, tr.district].filter(Boolean).join(" ")).includes(tribeQuery);
  function shown() {
    const sel = ctx.selected();
    return tribes.filter(tr => tr.memberCount > 0 && ctx.inScope(tr.lng, tr.lat) && (!sel.length || sel.includes(tr.team)) && matches(tr));
  }
  function render() {
    for (const mk of markers.values()) mk.remove(); markers = new Map();
    const list = shown().sort((a, b) => b.memberCount - a.memberCount);
    const z = map.getZoom(); zoomBand = band(z);
    if (visible && z >= TRIBE_ZOOM) {
      // several tribes in one city share a centre: fan them out around it
      const byCity = new Map(); for (const tr of list) { const k = tr.cityOsm; byCity.set(k, [...(byCity.get(k) || []), tr]); }
      for (const group of byCity.values()) group.forEach((tr, i) => {
        const n = group.length, a = i / n * 2 * Math.PI - Math.PI / 2, r = n > 1 ? 26 + n * 3 : 0;
        const el = document.createElement("button"); el.className = "tribe-mk" + (z < TRIBE_ZOOM_FULL ? " compact" : ""); el.title = titleOf(tr) + " · " + placeOf(tr);
        const d = document.createElement("span"); d.className = "dot"; ctx.paintDot(d, tr.team);
        const txt = document.createElement("span"); txt.className = "tm-text";
        const top = document.createElement("span"); top.className = "tm-top";
        const nm = document.createElement("b"); nm.className = "nm"; nm.textContent = titleOf(tr); top.append(nm);
        if (tr.name) top.append(teamTag(tr.team));
        const meta = document.createElement("span"); meta.className = "tm-meta"; meta.textContent = [membersText(tr.memberCount), foundedText(tr)].filter(Boolean).join(" · ");
        txt.append(top, meta); el.append(d, txt); el.onclick = ev => { ev.stopPropagation(); openTribe(tr.id, "map"); };
        markers.set(tr.id, new maplibregl.Marker({ element: el, offset: [Math.cos(a) * r, Math.sin(a) * r], opacityWhenCovered: "0" }).setLngLat([tr.lng, tr.lat]).addTo(map));
      });
    }
    const ul = $("#tribeList"); ul.replaceChildren();
    for (const tr of list.slice(0, 30)) {
      ul.append(tribeRow(tr, "list"));
    }
    if (!list.length) { const li = document.createElement("li"); li.className = "empty"; li.textContent = t("noTribes"); ul.append(li); }
  }
  // a two-line row (name + team tag / city · members · founded), used in the board list and in "My tribes"
  function tribeRow(tr, source) {
    const li = document.createElement("li"), b = document.createElement("button"); b.className = "tribe-row";
    const d = document.createElement("span"); d.className = "dot"; ctx.paintDot(d, tr.team);
    const txt = document.createElement("span"); txt.className = "tr-text";
    const top = document.createElement("span"); top.className = "tm-top";
    const nm = document.createElement("b"); nm.textContent = titleOf(tr); top.append(nm); if (tr.name) top.append(teamTag(tr.team));
    const sub = document.createElement("span"); sub.className = "tr-sub"; sub.textContent = subOf(tr);
    txt.append(top, sub); b.append(d, txt); b.onclick = () => openTribe(tr.id, source); li.append(b);
    return li;
  }
  function setVisible(v) { visible = v; $("#tribesBox").hidden = !v; render(); }

  /* ---------- sheet ---------- */
  const status = (msg, err) => { const s = $("#tsStatus"); s.textContent = msg || ""; s.classList.toggle("err", !!err); };
  function showSheet() { ctx.closePin?.(); sheet.hidden = false; ctx.setSheetOpen(true); }
  function closeSheet() {
    sheet.hidden = true; sheet.classList.remove("full"); ctx.setSheetOpen(false); stopWatching(); open = null;
    if (location.pathname.startsWith("/t/")) history.replaceState(null, "", "/" + location.search);
  }
  $("#tsClose").onclick = () => { closeSheet(); track("tribe_close"); };

  // phones: drag (or flick) the sheet up to full screen; down goes back to normal, then closes. While the feed is
  // scrolled, only the header starts a drag, so scrolling stays scrolling.
  const phone = matchMedia("(max-width:720px)");
  let drag = null;
  sheet.addEventListener("touchstart", e => {
    if (!phone.matches || e.target.closest("input, textarea")) return;
    if (sheet.scrollTop > 0 && !e.target.closest(".tribe-head")) return;
    drag = { y: e.touches[0].clientY, t: performance.now(), dy: 0 };
  }, { passive: true });
  sheet.addEventListener("touchmove", e => {
    if (!drag) return;
    drag.dy = e.touches[0].clientY - drag.y;
    sheet.style.transform = drag.dy > 0 ? `translateY(${drag.dy}px)` : ""; // follow the finger down only
  }, { passive: true });
  sheet.addEventListener("touchend", () => {
    if (!drag) return;
    const { dy, t } = drag, v = dy / Math.max(1, performance.now() - t); drag = null; sheet.style.transform = "";
    const full = sheet.classList.contains("full");
    if (dy < -40 || v < -0.5) { if (!full) { sheet.classList.add("full"); track("tribe_sheet_full"); } }
    else if (dy > 70 || v > 0.6) { if (full) sheet.classList.remove("full"); else { closeSheet(); track("tribe_close", { method: "swipe" }); } }
  });
  function stopWatching() {
    unsubPosts?.(); unsubPosts = null; unsubMember?.(); unsubMember = null;
    for (const u of replyWatch.values()) u(); replyWatch.clear();
  }
  function head(team, sub, title = team, tag = null) {
    ctx.paintDot($("#tsDot"), team); $("#tsTitle").textContent = title; $("#tsSub").textContent = sub;
    const slot = $("#tsTag"); slot.replaceChildren(); if (tag) slot.append(teamTag(tag));
  }
  // the team's matches today and tomorrow (fixtures.yml snapshots; the free plan sees no further ahead)
  async function renderFixtures(tr) {
    const box = $("#tsFixtures"); box.hidden = true;
    const list = await matchesOf(tr.team, 2).catch(() => []);
    if (open?.id !== tr.id) return;
    $("#tsFxList").replaceChildren(...list.map(fixtureRow));
    box.hidden = !list.length;
  }
  function fixtureRow(f) {
    const li = document.createElement("li"), live = !f.over && Date.now() >= f.kickoff; li.classList.toggle("over", f.over);
    const when = document.createElement("span"); when.className = "fx-when" + (live ? " live" : "");
    const day = new Intl.RelativeTimeFormat(ctx.locale(), { numeric: "auto" }).format(Math.round((new Date(f.kickoff).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / 86400000), "day");
    const hhmm = new Intl.DateTimeFormat(ctx.locale(), { hour: "2-digit", minute: "2-digit" }).format(f.kickoff);
    when.textContent = f.over ? t("matchOver") : live ? t("matchLive") : day.charAt(0).toUpperCase() + day.slice(1) + " " + hhmm;
    const teams = document.createElement("span"); teams.className = "fx-teams";
    for (const [name, side, i] of [[f.home, "h", 0], [f.away, "a", 1]]) {
      if (i) teams.append(" – ");
      const el = document.createElement(side === f.side ? "b" : "span"); el.textContent = name; teams.append(el);
    }
    const lg = document.createElement("span"); lg.className = "fx-league"; lg.textContent = f.league;
    li.append(when, teams, lg);
    return li;
  }
  function gate(textKey, btnKey, action, vars, btn2Key, action2) {
    const g = $("#tsGate"); g.hidden = !textKey; if (!textKey) return;
    $("#tsGateText").textContent = t(textKey, vars); const b = $("#tsGateBtn"), b2 = $("#tsGateBtn2"); b.hidden = !btnKey; b2.hidden = !btn2Key;
    if (btnKey) { b.textContent = t(btnKey); b.onclick = action; }
    if (btn2Key) { b2.textContent = t(btn2Key); b2.onclick = action2; }
    track("tribe_gate", { level: textKey });
  }

  function openTribe(id, source) {
    const tr = tribes.find(x => x.id === id);
    if (!tr) { if (source === "link") status(t("tribeMissing"), true); return; }
    const fresh = !open || open.id !== id;
    if (fresh) { stopWatching(); feed.replaceChildren(); status(""); }
    open = tr;
    if (fresh) renderFixtures(tr);
    $("#tsCreate").hidden = true; $("#tsActions").hidden = false; $("#tsNick").hidden = true; gate(null);
    head(tr.team, subOf(tr), titleOf(tr), tr.name ? tr.team : null);
    showSheet();
    history.replaceState(null, "", "/t/" + encodeURIComponent(id) + location.search);
    map.flyTo({ center: [tr.lng, tr.lat], zoom: Math.max(map.getZoom(), 9), duration: 900 });
    const fb = ctx.backend();
    if (fb && ctx.user() && !unsubMember) unsubMember = fb.watchMember(id, mbr => { member = mbr; paintMembership(); });
    // expired guests would keep inflating the count until they come back: whoever opens the tribe sweeps them (once a session)
    if (fb && ctx.user() && tr.memberCount > 1 && !swept.has(id)) { swept.add(id); fb.sweepGuests(id).catch(() => {}); }
    if (!ctx.user()) { member = null; paintMembership(); }
    if (fb && !unsubPosts) unsubPosts = fb.watchPosts(id, renderFeed, e => { status(t("offline"), true); track("store_error", { code: e.code || "unknown", source: "posts" }); });
    if (source !== "refresh") track("tribe_open", { team: tr.team, source });
  }
  function paintMembership() {
    if (!open) return;
    const guest = member?.role === "guest", expired = guest && tsMs(member.until) <= Date.now();
    if (expired) dropGuest(open);
    const isMember = !!member && !expired;
    $("#tsJoin").hidden = isMember; $("#tsLeave").hidden = !isMember;
    $("#tsComposer").hidden = !isMember;
    const role = member?.role === "captain" ? " · " + t("captain") : guest && !expired ? " · " + t("guestUntil", { when: new Intl.DateTimeFormat(ctx.locale(), { weekday: "short", hour: "2-digit", minute: "2-digit" }).format(tsMs(member.until)) }) : "";
    head(open.team, subOf(open) + role, titleOf(open), open.name ? open.team : null);
    relabel($("#tsShare"), ctx.user() ? "inviteLinkXp" : "inviteLink");
  }
  function relabel(el, key) { el.dataset.i18n = key; el.textContent = t(key); }

  // 3-team limit, mirrored from the stats ledger rule
  async function teamSlotOk(team) {
    let st = ctx.stats();
    if (!st) { await ctx.backend().claimDaily(); st = ctx.stats() || { teams: {} }; }
    const teams = st.teams || {};
    return team in teams || Object.keys(teams).length < 3;
  }

  /* username + community rules, asked once before the first join / create (the name may already exist from the account block) */
  function needProfile(then) {
    if (validUsername(profile?.nick) && profile?.rulesAt && !profile?.nameHidden) return false;
    afterNick = then; $("#tsNick").hidden = false;
    const inp = $("#nickInput"); if (validUsername(profile?.nick) && !profile?.nameHidden) inp.value = profile.nick; inp.focus();
    if (profile?.nameHidden) status(t("nameHiddenYou"), true);
    return true;
  }
  $("#tsNick").onsubmit = async e => {
    e.preventDefault();
    const nick = $("#nickInput").value.trim();
    const bad = usernameProblem(nick); if (bad) { status(t(bad), true); return; }
    if (!$("#rulesOk").checked) { status(t("rulesNeeded"), true); return; }
    try {
      await ctx.backend().claimUsername(nick, profile?.nick, true);
      profile = { ...profile, nick, rulesAt: Date.now(), nameHidden: false }; ctx.onProfile?.(profile);
      $("#tsNick").hidden = true; status(""); track("nick_set"); const f = afterNick; afterNick = null; f?.();
    } catch (err) { status(t(err.code === "taken" ? "nickTaken" : "saveFailed"), true); }
  };

  async function checkInHere(then) {
    if (!navigator.geolocation) { status(t("geoFailed"), true); return; }
    status(t("locating"));
    navigator.geolocation.getCurrentPosition(async p => {
      try { presence = await ctx.backend().checkIn(p.coords.latitude, p.coords.longitude); status(""); track("checkin"); then?.(); }
      catch (_) { status(t("saveFailed"), true); }
    }, () => { status(t("geoFailed"), true); track("checkin_error"); }, { enableHighAccuracy: false, timeout: 10000, maximumAge: 600000 });
  }

  // guest memberships live 3 days; the browser remembers them for "My tribes" and drops them once over
  const GUESTS = "tm.guests";
  const readGuests = () => { try { return JSON.parse(localStorage.getItem(GUESTS) || "{}"); } catch (_) { return {}; } };
  const writeGuests = g => { try { localStorage.setItem(GUESTS, JSON.stringify(g)); } catch (_) {} };
  const guestIds = () => Object.entries(readGuests()).filter(([, until]) => until > Date.now()).map(([id]) => id);
  const dropping = new Set(), swept = new Set();
  async function dropGuest(tr) {
    if (dropping.has(tr.id)) return; dropping.add(tr.id);
    const g = readGuests(); delete g[tr.id]; writeGuests(g);
    try { await ctx.backend()?.leaveTribe(tr.id, tr.team); } catch (_) {}
    dropping.delete(tr.id); ctx.onMembership?.();
  }
  async function joinGuest() {
    if (!open || !ctx.user() || !profileLoaded) return;
    if (needProfile(joinGuest)) return;
    try {
      if (member) await ctx.backend().leaveTribe(open.id, open.team); // an expired guest doc first
      const until = await ctx.backend().joinAsGuest(open.id, profile.nick);
      writeGuests({ ...readGuests(), [open.id]: until }); gate(null); status(t("joinedGuest"));
      track("tribe_join", { team: open.team, method: "guest" }); ctx.onMembership?.();
    } catch (e) { status(t("saveFailed"), true); track("tribe_join_error", { code: e.code || "unknown", method: "guest" }); }
  }
  async function join() {
    if (!open) return;
    if (!ctx.user()) { gate("gateSignIn", "signIn", () => { closeSheet(); ctx.openAuth(); }); return; }
    if (!profileLoaded) return;
    if (needProfile(join)) return;
    const why = nearReason(open);
    if (!why) { gate("gateNear", "imHere", () => checkInHere(() => { gate(null); join(); }), { city: placeOf(open) }, "joinGuest", joinGuest); return; }
    if (!(await teamSlotOk(open.team))) { gate("teamLimit"); return; }
    try {
      const r = await ctx.backend().joinTribe(open.id, open.team, profile.nick, refFor(open.id));
      gate(null); status(t("joined") + (r.first ? " +50 XP" : ""));
      track("tribe_join", { team: open.team, method: why, source: r.referred ? "invite" : "direct" });
    } catch (e) { status(t(e.code === "permission-denied" ? "joinDenied" : "saveFailed"), true); track("tribe_join_error", { code: e.code || "unknown" }); }
  }
  $("#tsJoin").onclick = join;
  $("#tsLeave").onclick = async () => {
    // a captain hands over to the longest-standing member; alone, the tribe and its feed go
    const captain = member?.role === "captain", alone = captain && (open.memberCount || 0) <= 1;
    if (!open || !confirm(t(alone ? "leaveConfirmLast" : captain ? "leaveConfirmCaptain" : "leaveConfirm"))) return;
    const team = open.team;
    try {
      const r = await ctx.backend().leaveTribe(open.id, team);
      track("tribe_leave", { team, role: captain ? "captain" : "member", deleted: r.deleted });
      if (r.deleted) { closeSheet(); ctx.flash(t("tribeDeleted")); }
      else status(r.heir ? t("leftHandedOver", { nick: "@" + r.heir }) : t("left"));
    } catch (_) { status(t("saveFailed"), true); }
  };
  // signed in: the link carries my uid, so I get +100 XP when someone joins through it for the first time
  $("#tsShare").onclick = async () => {
    if (!open) return;
    const me = ctx.backend()?.currentUid();
    const url = location.origin + "/t/" + encodeURIComponent(open.id) + (me ? "?ref=" + encodeURIComponent(me) : "");
    const title = titleOf(open) + " · " + placeOf(open) + " – TribeMap";
    try { if (navigator.share) await navigator.share({ title, url }); else { await navigator.clipboard.writeText(url); status(t("linkCopied")); } track("tribe_share", { team: open.team, on: !!me }); }
    catch (_) {}
  };

  /* ---------- create ---------- */
  let pickedCity = null, pickedDistrict = null;
  const districtField = $("#tcDistrict");
  const cityCombo = ctx.asyncCombo($("#tcCity"), $("#tcCityOpts"), {
    search: (q, signal) => ctx.searchAreas(q, "city", ctx.lang(), signal),
    onInput: () => { pickedCity = null; $("#tcSave").disabled = true; districtCombo.clear(); pickedDistrict = null; districtField.disabled = true; },
    onPick: c => { pickedCity = c; $("#tcSave").disabled = !c.osm; districtField.disabled = !c.osm; if (!c.osm) status(t("cityNoId"), true); },
  });
  // optional: a district / neighbourhood of the picked city makes a tribe of its own next to the city one
  const districtCombo = ctx.asyncCombo(districtField, $("#tcDistrictOpts"), {
    search: (q, signal) => pickedCity ? ctx.searchDistricts(q, pickedCity, ctx.lang(), signal) : Promise.resolve([]),
    onInput: () => { pickedDistrict = null; },
    onPick: d => { pickedDistrict = d; },
  });
  function startCreate() {
    stopWatching(); open = null; feed.replaceChildren(); status(""); gate(null);
    $("#tsActions").hidden = true; $("#tsComposer").hidden = true; $("#tsNick").hidden = true; $("#tsFixtures").hidden = true;
    const pin = ctx.myPin();
    head(pin ? pin.t : t("newTribe"), t("newTribeSub"));
    showSheet();
    if (!ctx.user()) { $("#tsCreate").hidden = true; gate("gateSignIn", "signIn", () => { closeSheet(); ctx.openAuth(); }); return; }
    if (!pin) { $("#tsCreate").hidden = true; gate("gatePin", "cta", () => { closeSheet(); ctx.openPinSheet(); }); return; }
    $("#tsCreate").hidden = false; $("#tcTeam").textContent = pin.t; cityCombo.clear(); pickedCity = null; $("#tcSave").disabled = true; $("#tcName").value = "";
    districtCombo.clear(); pickedDistrict = null; districtField.disabled = true;
    track("tribe_create_start");
  }
  $("#tribeSearch").addEventListener("input", e => { tribeQuery = fold(e.target.value.trim()); render(); });
  $("#tcSave").onclick = async function create() {
    const pin = ctx.myPin(); if (!pin || !pickedCity?.osm) return;
    const name = $("#tcName").value.trim().replace(/\s+/g, " ");
    if (name && (name.length < 3 || name.length > 40)) { status(t("tribeNameInvalid"), true); return; }
    if (name && isProfane(name)) { status(t("profane"), true); track("tribe_name_blocked"); return; }
    if (needProfile(create)) return;
    const place = pickedDistrict || pickedCity; // a district tribe takes the district's OSM id and centre
    const fb = ctx.backend(), tid = fb.tribeId(pin.t, place.osm);
    if (tribes.some(x => x.id === tid)) { openTribe(tid, "exists"); return; }
    const tr = { team: pin.t, name: name || null, city: pickedCity.name, district: pickedDistrict?.name || null, cityOsm: place.osm, country: (pickedCity.sub || "").split(", ").pop() || "", lat: +place.lat.toFixed(4), lng: +place.lng.toFixed(4) };
    if (!nearReason(tr)) { gate("gateNear", "imHere", () => checkInHere(() => { gate(null); create(); }), { city: placeOf(tr) }); return; }
    if (!(await teamSlotOk(tr.team))) { gate("teamLimit"); return; }
    $("#tcSave").disabled = true;
    try {
      await fb.createTribe(tr, profile.nick); track("tribe_create", { team: tr.team, custom: !!name });
      // the local write already fired the tribes snapshot: open it now, or once the snapshot brings it
      if (tribes.some(x => x.id === tid)) openTribe(tid, "create"); else pendingOpen = tid;
      status(t("created") + " +50 XP");
    }
    catch (e) { $("#tcSave").disabled = false; status(t(e.code === "permission-denied" ? "gateNearShort" : "saveFailed"), true); track("tribe_create_error", { code: e.code || "unknown" }); }
  };

  /* ---------- feed ---------- */
  const rtf = () => new Intl.RelativeTimeFormat(ctx.locale(), { numeric: "auto" });
  function ago(ms) {
    const s = (ms - Date.now()) / 1000, f = rtf();
    for (const [u, sec] of [["day", 86400], ["hour", 3600], ["minute", 60]]) if (Math.abs(s) >= sec) return f.format(Math.round(s / sec), u);
    return f.format(0, "second");
  }
  const tsMs = v => v?.toMillis?.() ?? Date.now();
  const isCaptain = () => member && (member.role === "captain" || member.role === "cocaptain");

  function line(item, kind, pid) {
    const me = ctx.backend()?.currentUid();
    const wrap = document.createElement("div"); wrap.className = kind;
    const hiddenForAll = item.hidden || (kind === "post" && item.reportCount >= 3);
    const meta = document.createElement("div"); meta.className = "meta";
    const nb = document.createElement("b"); nb.textContent = item.nick; nameLabel(nb, item);
    meta.append(nb);
    if (item.guest) { const g = document.createElement("span"); g.className = "team-tag guest-tag"; g.textContent = t("guestTag"); meta.append(" ", g); }
    meta.append(document.createTextNode(" · " + ago(tsMs(item.createdAt))));
    const body = document.createElement("p");
    if (hiddenForAll && !isCaptain() && item.authorUid !== me) { body.className = "muted"; body.textContent = t("hiddenPost"); wrap.append(meta, body); return wrap; }
    body.textContent = item.text; if (hiddenForAll) body.classList.add("dim");
    const acts = document.createElement("div"); acts.className = "acts";
    const btn = (key, fn, vars) => { const b = document.createElement("button"); b.type = "button"; b.className = "textbtn"; b.textContent = t(key, vars); b.onclick = fn; acts.append(b); return b; };
    if (kind === "post") btn("replies", () => toggleReplies(item, wrap), { n: num(item.replyCount || 0) });
    if (me && item.authorUid !== me && kind === "post") btn("report", () => report(item));
    if (me && item.authorUid !== me) btn("reportName", () => reportName(item));
    if (isCaptain() && kind === "post") btn(item.hidden ? "unhide" : "hide", () => hide(item));
    if (me && item.authorUid === me) btn("delete", () => remove(item, kind, pid));
    wrap.append(meta, body, acts);
    return wrap;
  }
  function renderFeed(posts) {
    const openIds = new Set([...feed.querySelectorAll("li[data-open]")].map(li => li.dataset.id));
    feed.replaceChildren();
    for (const p of posts) {
      const li = document.createElement("li"); li.dataset.id = p.id; li.append(line(p, "post"));
      feed.append(li);
      if (openIds.has(p.id)) { li.dataset.open = "1"; mountReplies(p, li); }
    }
    if (!posts.length) { const li = document.createElement("li"); li.className = "empty"; li.textContent = t("noPosts"); feed.append(li); }
  }
  function mountReplies(p, li) {
    const box = document.createElement("div"); box.className = "replies"; const ul = document.createElement("div"); box.append(ul);
    if (member) {
      const f = document.createElement("form"); f.className = "composer sm"; f.dataset.clarityMask = "true";
      const ta = document.createElement("input"); ta.className = "field sm"; ta.maxLength = 500; ta.placeholder = t("replyPh"); ta.setAttribute("aria-label", t("replyPh"));
      const b = document.createElement("button"); b.className = "chipbtn"; b.textContent = t("send");
      f.append(ta, b); f.onsubmit = async e => { e.preventDefault(); await sendReply(p, ta); }; box.append(f);
    }
    li.append(box);
    replyWatch.get(p.id)?.(); replyWatch.set(p.id, ctx.backend().watchReplies(open.id, p.id, rs => { ul.replaceChildren(...rs.map(r => line(r, "reply", p.id))); }));
  }
  function toggleReplies(p, wrap) {
    const li = wrap.parentElement;
    if (li.dataset.open) { delete li.dataset.open; li.querySelector(".replies")?.remove(); replyWatch.get(p.id)?.(); replyWatch.delete(p.id); return; }
    li.dataset.open = "1"; mountReplies(p, li); track("replies_open");
  }
  const tooFast = e => e.code === "permission-denied";
  $("#tsComposer").onsubmit = async e => {
    e.preventDefault(); const ta = $("#postText"), text = ta.value.trim(); if (!text || !open || !member) return;
    if (isProfane(text)) { status(t("profane"), true); track("post_blocked"); return; }
    try { await ctx.backend().createPost(open.id, member.nick, text, member.role === "guest"); ta.value = ""; status(""); track("post_create", { team: open.team }); }
    catch (err) { status(t(tooFast(err) ? "postTooFast" : "saveFailed"), true); track("post_error", { code: err.code || "unknown" }); }
  };
  async function sendReply(p, input) {
    const text = input.value.trim(); if (!text || !member) return;
    if (isProfane(text)) { status(t("profane"), true); track("post_blocked"); return; }
    try { await ctx.backend().createReply(open.id, p.id, member.nick, text, member.role === "guest"); input.value = ""; track("reply_create", { team: open.team }); }
    catch (err) { if (import.meta.env.DEV) console.warn("reply", err); status(t(tooFast(err) ? "postTooFast" : "saveFailed"), true); }
  }
  /* names hidden by 3 reports show as "Fan#ABCD" (stable per author); looked up once per name and cached */
  const hiddenNames = new Map(); // lowercase nick -> boolean
  const hiddenLabel = item => t("hiddenName", { tag: String(item.authorUid || "").slice(0, 4).toUpperCase() });
  function nameLabel(el, item) {
    const k = String(item.nick || "").toLowerCase();
    if (hiddenNames.get(k)) { el.textContent = hiddenLabel(item); return; }
    if (hiddenNames.has(k) || !ctx.backend()) return;
    hiddenNames.set(k, false);
    ctx.backend().nameHidden(item.nick).then(h => { hiddenNames.set(k, h); if (h && el.isConnected) el.textContent = hiddenLabel(item); });
  }
  async function reportName(item) {
    if (!confirm(t("reportNameConfirm"))) return;
    try { await ctx.backend().reportName(item.nick); hiddenNames.delete(item.nick.toLowerCase()); status(t("nameReported")); track("name_report"); }
    catch (e) { status(t(e.code === "permission-denied" ? "alreadyReported" : "saveFailed")); }
  }
  async function report(p) {
    if (!confirm(t("reportConfirm"))) return;
    try { await ctx.backend().reportPost(open.id, p.id, "abuse"); status(t("reported")); track("post_report"); }
    catch (_) { status(t("alreadyReported")); }
  }
  async function hide(p) { try { await ctx.backend().setPostHidden(open.id, p.id, !p.hidden); track("post_hide", { on: !p.hidden }); } catch (_) { status(t("saveFailed"), true); } }
  async function remove(item, kind, pid) {
    if (!confirm(t("deleteConfirm"))) return;
    try { if (kind === "post") await ctx.backend().deletePost(open.id, item.id); else await ctx.backend().deleteReply(open.id, pid, item.id); track(kind + "_delete"); }
    catch (_) { status(t("saveFailed"), true); }
  }

  return {
    setBackend, onUser, render, setVisible, isOpen: () => !sheet.hidden, close: closeSheet, setProfile: p => { profile = p; },
    get: id => tribes.find(x => x.id === id), guestIds, create: () => startCreate(), open: id => openTribe(id, "account"), row: tr => tribeRow(tr, "account"),
  };
}
