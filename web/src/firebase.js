/* Auth (Google + email link) and the shared pin store. Loaded lazily by main.js after the map is up.
   Public web config only; access is enforced by firestore.rules. */
import { initializeApp } from "firebase/app";
import {
  getAuth, connectAuthEmulator, onAuthStateChanged, GoogleAuthProvider, signInWithPopup, signInWithRedirect, signOut as fbSignOut,
  sendSignInLinkToEmail, isSignInWithEmailLink, signInWithEmailLink, browserLocalPersistence, setPersistence,
} from "firebase/auth";
import {
  getFirestore, connectFirestoreEmulator, collection, doc, onSnapshot, setDoc, getDoc, deleteDoc, updateDoc, serverTimestamp,
  writeBatch, increment, query, orderBy, limit, arrayUnion, arrayRemove, deleteField, FieldPath, getDocs, where, collectionGroup,
} from "firebase/firestore";
import { deleteUser } from "firebase/auth";

const app = initializeApp({
  apiKey: "AIzaSyCNvRnmwpSec8hqeU6lI98FKacOiwrzO7Q",
  // same-origin auth handler on the live site avoids third-party-cookie problems with the popup
  authDomain: location.hostname === "tribemap.web.app" ? "tribemap.web.app" : "tribemap-app.firebaseapp.com",
  projectId: "tribemap-app",
  storageBucket: "tribemap-app.firebasestorage.app",
  messagingSenderId: "537441438640",
  appId: "1:537441438640:web:97f8dfdb3004b9252ce475",
});
const auth = getAuth(app);
const db = getFirestore(app);
// dev only: `npm run emulators` + http://localhost:5173/?emu → local Auth + Firestore, no production data touched
const EMU = import.meta.env.DEV && new URLSearchParams(location.search).has("emu");
if (EMU) {
  connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  connectFirestoreEmulator(db, "127.0.0.1", 8085);
}
setPersistence(auth, browserLocalPersistence).catch(() => {});

const EMAIL_KEY = "tm.email";

export const onUser = fn => onAuthStateChanged(auth, fn);

export async function signInGoogle() {
  const p = new GoogleAuthProvider();
  try { await signInWithPopup(auth, p); }
  catch (e) { if (e.code === "auth/popup-blocked" || e.code === "auth/operation-not-supported-in-this-environment") await signInWithRedirect(auth, p); else throw e; }
}

export async function sendEmailLink(email, lang) {
  auth.languageCode = lang; // Firebase appends ?lang= to the link; keep it equal to the UI language
  const back = location.origin + "/?signin=1" + (EMU ? "&emu" : "");
  await sendSignInLinkToEmail(auth, email, { url: back, handleCodeInApp: true });
  try { localStorage.setItem(EMAIL_KEY, email); } catch (_) {}
}

/* Completes an email-link sign-in if this page load came from one. askEmail() is used on another device. */
export async function completeEmailLink(askEmail) {
  if (!isSignInWithEmailLink(auth, location.href)) return false;
  let email = null; try { email = localStorage.getItem(EMAIL_KEY); } catch (_) {}
  if (!email) email = askEmail();
  if (!email) return false;
  await signInWithEmailLink(auth, email, location.href);
  try { localStorage.removeItem(EMAIL_KEY); } catch (_) {}
  const u = new URL(location.href); for (const k of [...u.searchParams.keys()]) if (k !== "lang" && k !== "emu") u.searchParams.delete(k);
  history.replaceState(null, "", u.pathname + u.search);
  return true;
}

export const signOut = () => fbSignOut(auth);

function clean(d) {
  if (!d || typeof d.t !== "string") return null; const t = d.t.trim().slice(0, 40); if (!t) return null;
  const lat = +d.lat, lng = +d.lng; if (!isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 85 || Math.abs(lng) > 180) return null;
  return { t, lat, lng, p: ["exact", "area", "city"].includes(d.p) ? d.p : "area", demo: false };
}

/* Live pin set. Fine on the free tier while pins are few; F1b moves reads to a CDN-cached API. */
export function watchPins(onPins, onError) {
  return onSnapshot(collection(db, "pins"), snap => {
    const m = new Map(); for (const d of snap.docs) { const p = clean(d.data()); if (p) m.set(d.id, p); }
    onPins(m);
  }, onError);
}

// pin is already blurred by the caller; only team, blurred coords and precision leave the device
export const savePin = pin => setDoc(doc(db, "pins", auth.currentUser.uid), { t: pin.t, lat: pin.lat, lng: pin.lng, p: pin.p, ts: serverTimestamp() });
export const deletePin = () => deleteDoc(doc(db, "pins", auth.currentUser.uid));

/* ---------- tribes (see firestore.rules for what each batch must contain) ---------- */
const uid = () => auth.currentUser.uid;
const snapData = d => ({ id: d.id, ...d.data({ serverTimestamps: "estimate" }) });

export async function getProfile() { const s = await getDoc(doc(db, "users", uid())); return s.exists() ? s.data() : null; }
/* username: claim usernames/{lowercase} and update the profile in one batch; release the old claim if it was mine */
export async function claimUsername(nick, oldNick, acceptRules) {
  const me = uid(), lower = nick.toLowerCase(), b = writeBatch(db);
  const taken = await getDoc(doc(db, "usernames", lower));
  if (taken.exists() && taken.data().uid !== me) { const e = new Error("taken"); e.code = "taken"; throw e; }
  if (!taken.exists()) b.set(doc(db, "usernames", lower), { uid: me });
  const oldLower = oldNick?.toLowerCase();
  if (oldLower && oldLower !== lower) {
    // a name hidden by reports stays reserved (the rules refuse to release it)
    const old = await getDoc(doc(db, "usernames", oldLower));
    if (old.exists() && old.data().uid === me && (old.data().reports || 0) < 3) b.delete(doc(db, "usernames", oldLower));
  }
  b.set(doc(db, "users", me), acceptRules ? { nick, rulesAt: serverTimestamp() } : { nick }, { merge: true });
  // my member docs follow the new name, so I can keep posting in my tribes
  const s = await readStats();
  for (const tid of s?.current || []) b.update(doc(db, "tribes", tid, "members", me), { nick });
  await b.commit();
  nameFlags.delete(lower);
}

/* match day: one cheer per account per match, counter of my side +1, +25 XP the first cheer of the (UTC) day */
export async function cheer(fx, pin) {
  const me = uid(), cid = fx.id + "_" + me, b = writeBatch(db);
  b.set(doc(db, "cheers", cid), { f: fx.id, u: me, side: fx.side, team: pin.t, lat: pin.lat, lng: pin.lng, ts: serverTimestamp() });
  b.set(doc(db, "matches", String(fx.id)), { [fx.side]: increment(1) }, { merge: true });
  const s = await readStats();
  const xp = !!s && utcDay(s.lastCheerAt?.toMillis?.() || 0) < utcDay(Date.now());
  if (xp) b.update(statsRef(me), { xp: increment(25), lastCheerAt: serverTimestamp(), lastCheer: cid });
  await b.commit();
  return { xp };
}
export const hasCheered = async f => (await getDoc(doc(db, "cheers", f + "_" + uid()))).exists();
export const watchMatch = (f, cb) => onSnapshot(doc(db, "matches", String(f)), s => cb(s.exists() ? s.data() : {}), () => cb({}));
export const loadCheers = async f => (await getDocs(query(collection(db, "cheers"), where("f", "==", f), limit(3000)))).docs.map(d => d.data());

/* ---------- GDPR: my data (export) and account deletion ---------- */
const plain = v => v && typeof v.toDate === "function" ? v.toDate().toISOString() : Array.isArray(v) ? v.map(plain)
  : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)])) : v;
const one = async (...path) => { const s = await getDoc(doc(db, ...path)); return s.exists() ? plain(s.data()) : null; };
async function myMemberships(me) {
  // tribes are few, so checking every tribe for my member doc also finds memberships from before the ledger existed
  const tribes = await getDocs(collection(db, "tribes")), out = [];
  for (const t of tribes.docs) { const m = await getDoc(doc(db, "tribes", t.id, "members", me)); if (m.exists()) out.push({ tid: t.id, team: t.data().team, ...plain(m.data()) }); }
  return out;
}
export async function exportMyData() {
  const me = uid(), u = auth.currentUser;
  const [profile, pin, presence, stats, posts, replies, cheers, memberships] = await Promise.all([
    one("users", me), one("pins", me), one("presence", me), one("stats", me),
    getDocs(query(collectionGroup(db, "posts"), where("authorUid", "==", me))),
    getDocs(query(collectionGroup(db, "replies"), where("authorUid", "==", me))),
    getDocs(query(collection(db, "cheers"), where("u", "==", me))),
    myMemberships(me),
  ]);
  return {
    exportedAt: new Date().toISOString(),
    account: { uid: me, email: u.email, providers: u.providerData.map(p => p.providerId), created: u.metadata.creationTime, lastSignIn: u.metadata.lastSignInTime },
    profile, pin, presence, stats, memberships,
    posts: posts.docs.map(d => ({ path: d.ref.path, ...plain(d.data()) })),
    replies: replies.docs.map(d => ({ path: d.ref.path, ...plain(d.data()) })),
    cheers: cheers.docs.map(d => plain(d.data())),
  };
}
// Deleting the sign-in itself needs a recent sign-in; check first, so data and account go together.
export const recentlySignedIn = (minutes = 4) => Date.now() - Date.parse(auth.currentUser?.metadata.lastSignInTime || 0) < minutes * 60000;
export async function deleteMyAccount(onStep = () => {}) {
  const me = uid();
  onStep("posts");
  for (const g of ["replies", "posts"]) for (const d of (await getDocs(query(collectionGroup(db, g), where("authorUid", "==", me)))).docs) await deleteDoc(d.ref);
  onStep("tribes");
  for (const m of await myMemberships(me)) await leaveTribe(m.tid, m.team);
  onStep("cheers");
  for (const d of (await getDocs(query(collection(db, "cheers"), where("u", "==", me)))).docs) await deleteDoc(d.ref);
  onStep("profile");
  const b = writeBatch(db), profile = await one("users", me);
  for (const p of [["pins", me], ["presence", me], ["stats", me], ["users", me]]) if (await one(...p)) b.delete(doc(db, ...p));
  if (profile?.nick) { const k = profile.nick.toLowerCase(), c = await one("usernames", k); if (c?.uid === me && (c.reports || 0) < 3) b.delete(doc(db, "usernames", k)); }
  await b.commit();
  onStep("account");
  await deleteUser(auth.currentUser);
}

/* name reports: one per reporter per name; at 3 the name is hidden everywhere and must be changed */
const nameFlags = new Map(); // lowercase nick -> Promise<boolean hidden>
export function nameHidden(nick) {
  const k = String(nick || "").toLowerCase();
  if (!nameFlags.has(k)) nameFlags.set(k, getDoc(doc(db, "usernames", k)).then(s => s.exists() && (s.data().reports || 0) >= 3).catch(() => false));
  return nameFlags.get(k);
}
export async function reportName(nick) {
  const k = nick.toLowerCase(), b = writeBatch(db);
  b.set(doc(db, "usernames", k, "reports", uid()), { createdAt: serverTimestamp() });
  b.update(doc(db, "usernames", k), { reports: increment(1) });
  await b.commit();
  nameFlags.delete(k);
}

// "I'm here now": city-level (0.05° grid), private, valid 72 h for joining nearby tribes
const grid = v => Math.round(v / 0.05) * 0.05;
export async function checkIn(lat, lng) {
  const at = { lat: +grid(lat).toFixed(4), lng: +grid(lng).toFixed(4) };
  await setDoc(doc(db, "presence", uid()), { ...at, ts: serverTimestamp() });
  return { ...at, ts: Date.now() };
}
export async function getPresence() {
  const s = await getDoc(doc(db, "presence", uid()));
  if (!s.exists()) return null; const d = s.data();
  return { lat: d.lat, lng: d.lng, ts: d.ts?.toMillis?.() || 0 };
}

export const tribeId = (team, cityOsm) => cityOsm + "_" + team.toLowerCase().replace(/[^a-z0-9]+/g, "-");
export const watchTribes = (onTribes, onError) => onSnapshot(collection(db, "tribes"), s => onTribes(s.docs.map(snapData)), onError);
export const watchMember = (tid, cb) => onSnapshot(doc(db, "tribes", tid, "members", uid()), s => cb(s.exists() ? s.data() : null), () => cb(null));

/* ---------- XP + membership ledger (stats/{uid}); see firestore.rules for what each write may do ---------- */
const statsRef = u => doc(db, "stats", u);
const readStats = async () => { const s = await getDoc(statsRef(uid())); return s.exists() ? s.data() : null; };
export const watchStats = cb => onSnapshot(statsRef(uid()), s => cb(s.exists() ? s.data({ serverTimestamps: "estimate" }) : null), () => cb(null));
const utcDay = ms => Math.floor(ms / 86400000);
// +10 XP once per UTC day; creates the ledger on the very first visit. Returns true when XP was granted.
export async function claimDaily() {
  const s = await readStats();
  if (!s) { await setDoc(statsRef(uid()), { xp: 10, lastDailyAt: serverTimestamp(), refs: 0, teams: {}, joined: [], current: [] }); return true; }
  if (utcDay(s.lastDailyAt?.toMillis?.() || 0) >= utcDay(Date.now())) return false;
  await updateDoc(statsRef(uid()), { xp: increment(10), lastDailyAt: serverTimestamp() });
  return true;
}
async function ledgerJoin(b, tid, team) {
  const s = await readStats(), first = !s.joined.includes(tid);
  b.update(statsRef(uid()), new FieldPath("teams", team), increment(1), "current", arrayUnion(tid), "joined", arrayUnion(tid), "xp", increment(first ? 50 : 0), "lastJoin", tid);
  return first;
}

export async function createTribe(t, nick) {
  const tid = tribeId(t.team, t.cityOsm), b = writeBatch(db);
  b.set(doc(db, "tribes", tid), { team: t.team, ...(t.name ? { name: t.name } : {}), city: t.city, cityOsm: t.cityOsm, country: t.country || "", lat: t.lat, lng: t.lng, memberCount: 1, createdAt: serverTimestamp(), lastActivityAt: serverTimestamp() });
  b.set(doc(db, "tribes", tid, "members", uid()), { nick, role: "captain", joinedAt: serverTimestamp() });
  await ledgerJoin(b, tid, t.team);
  await b.commit(); return tid;
}
// ref: the inviter's uid from the invite link. They get +100 XP the first time I join this tribe.
export async function joinTribe(tid, team, nick, ref) {
  const me = uid(), b = writeBatch(db);
  const okRef = ref && ref !== me && (await getDoc(statsRef(ref))).exists() ? ref : null;
  b.set(doc(db, "tribes", tid, "members", me), { nick, role: "member", joinedAt: serverTimestamp(), ...(okRef ? { ref: okRef } : {}) });
  b.update(doc(db, "tribes", tid), { memberCount: increment(1), lastActivityAt: serverTimestamp() });
  const first = await ledgerJoin(b, tid, team);
  if (okRef && first) b.update(statsRef(okRef), { xp: increment(100), refs: increment(1) });
  await b.commit();
  return { first, referred: !!(okRef && first) };
}
export async function leaveTribe(tid, team) {
  const b = writeBatch(db), s = await readStats();
  b.delete(doc(db, "tribes", tid, "members", uid()));
  b.update(doc(db, "tribes", tid), { memberCount: increment(-1) });
  if (s) {
    const args = ["current", arrayRemove(tid), "lastLeave", tid], n = s.teams?.[team] || 0;
    if (s.current.includes(tid) && n >= 1) args.push(new FieldPath("teams", team), n === 1 ? deleteField() : increment(-1));
    b.update(statsRef(uid()), ...args);
  }
  return b.commit();
}

export const watchPosts = (tid, cb, onError) =>
  onSnapshot(query(collection(db, "tribes", tid, "posts"), orderBy("createdAt", "desc"), limit(30)), s => cb(s.docs.map(snapData)), onError);
export const watchReplies = (tid, pid, cb) =>
  onSnapshot(query(collection(db, "tribes", tid, "posts", pid, "replies"), orderBy("createdAt", "asc"), limit(100)), s => cb(s.docs.map(snapData)), () => cb([]));

export function createPost(tid, nick, text) {
  const b = writeBatch(db), me = uid();
  b.update(doc(db, "tribes", tid, "members", me), { lastPostAt: serverTimestamp() });
  b.set(doc(collection(db, "tribes", tid, "posts")), { authorUid: me, nick, type: "text", text, createdAt: serverTimestamp(), replyCount: 0, reportCount: 0, hidden: false });
  b.update(doc(db, "tribes", tid), { lastActivityAt: serverTimestamp() });
  return b.commit();
}
export function createReply(tid, pid, nick, text) {
  const b = writeBatch(db), me = uid();
  b.update(doc(db, "tribes", tid, "members", me), { lastPostAt: serverTimestamp() });
  b.update(doc(db, "tribes", tid, "posts", pid), { replyCount: increment(1) });
  b.set(doc(collection(db, "tribes", tid, "posts", pid, "replies")), { authorUid: me, nick, text, createdAt: serverTimestamp(), hidden: false });
  return b.commit();
}
export function reportPost(tid, pid, reason) {
  const b = writeBatch(db);
  b.set(doc(db, "tribes", tid, "posts", pid, "reports", uid()), { reason, createdAt: serverTimestamp() });
  b.update(doc(db, "tribes", tid, "posts", pid), { reportCount: increment(1) });
  return b.commit();
}
export const setPostHidden = (tid, pid, hidden) => updateDoc(doc(db, "tribes", tid, "posts", pid), { hidden });
export const deletePost = (tid, pid) => deleteDoc(doc(db, "tribes", tid, "posts", pid));
export const deleteReply = (tid, pid, rid) => deleteDoc(doc(db, "tribes", tid, "posts", pid, "replies", rid));
export const currentUid = () => auth.currentUser?.uid || null;
