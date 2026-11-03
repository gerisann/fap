// Firestore security rules, run against the emulator: npm run test:rules
import { test, before, after, beforeEach } from "node:test";
import { readFileSync } from "node:fs";
import { initializeTestEnvironment, assertSucceeds, assertFails } from "@firebase/rules-unit-testing";
import { doc, setDoc, getDoc, deleteDoc, writeBatch, serverTimestamp, increment, updateDoc, arrayUnion, arrayRemove, deleteField, FieldPath } from "firebase/firestore";

let env;
before(async () => {
  env = await initializeTestEnvironment({
    projectId: "demo-tribemap",
    firestore: { rules: readFileSync("firestore.rules", "utf8"), host: "127.0.0.1", port: 8085 },
  });
});
after(() => env.cleanup());
beforeEach(() => env.clearFirestore());

const db = (uid, verified = true) => env.authenticatedContext(uid, { email_verified: verified }).firestore();
const slug = team => team.toLowerCase().replace(/[^a-z0-9]+/g, "-"); // must match the rule's lower().replace()
const BUD = { city: "Budapest", cityOsm: "R37244", country: "Magyarország", lat: 47.4979, lng: 19.0402 };
const LON = { lat: 51.5072, lng: -0.1276 };
const tidOf = (team, c = BUD) => c.cityOsm + "_" + slug(team);

const pin = (uid, t, at = BUD) => setDoc(doc(db(uid), "pins", uid), { t, lat: at.lat, lng: at.lng, p: "area", ts: serverTimestamp() });
const daily = uid => setDoc(doc(db(uid), "stats", uid), { xp: 10, lastDailyAt: serverTimestamp(), refs: 0, teams: {}, joined: [], current: [] });
async function nick(uid, n = "Fan_" + uid, rules = true) { // claim the username + write the profile in one batch
  const d = db(uid), b = writeBatch(d);
  b.set(doc(d, "usernames", n.toLowerCase()), { uid });
  b.set(doc(d, "users", uid), rules ? { nick: n, rulesAt: serverTimestamp() } : { nick: n });
  await b.commit();
  if (!(await getDoc(doc(d, "stats", uid))).exists()) await daily(uid);
}
const here = (uid, at) => setDoc(doc(db(uid), "presence", uid), { lat: at.lat, lng: at.lng, ts: serverTimestamp() });
const stats = async uid => (await getDoc(doc(db(uid), "stats", uid))).data();

// mirrors the client: the ledger update rides in the same batch as the member doc
async function ledgerJoin(d, uid, b, tid, team) {
  const s = await stats(uid), first = !s.joined.includes(tid);
  b.update(doc(d, "stats", uid), new FieldPath("teams", team), increment(1), "current", arrayUnion(tid), "joined", arrayUnion(tid), "xp", increment(first ? 50 : 0), "lastJoin", tid);
  return first;
}
async function createTribe(uid, team, c = BUD, n = "Fan_" + uid, tid = tidOf(team, c), extra = {}) {
  const d = db(uid), b = writeBatch(d);
  b.set(doc(d, "tribes", tid), { team, city: c.city, cityOsm: c.cityOsm, country: c.country, lat: c.lat, lng: c.lng, memberCount: 1, createdAt: serverTimestamp(), lastActivityAt: serverTimestamp(), ...extra });
  b.set(doc(d, "tribes", tid, "members", uid), { nick: n, role: "captain", joinedAt: serverTimestamp() });
  await ledgerJoin(d, uid, b, tid, team);
  return b.commit();
}
async function join(uid, tid, n = "Fan_" + uid, ref = null) {
  const d = db(uid), b = writeBatch(d), team = (await getDoc(doc(d, "tribes", tid))).data().team;
  b.set(doc(d, "tribes", tid, "members", uid), { nick: n, role: "member", joinedAt: serverTimestamp(), ...(ref ? { ref } : {}) });
  b.update(doc(d, "tribes", tid), { memberCount: increment(1), lastActivityAt: serverTimestamp() });
  const first = await ledgerJoin(d, uid, b, tid, team);
  if (ref && first) b.update(doc(d, "stats", ref), { xp: increment(100), refs: increment(1) });
  return b.commit();
}
async function leave(uid, tid) {
  const d = db(uid), b = writeBatch(d), team = (await getDoc(doc(d, "tribes", tid))).data().team, s = await stats(uid);
  b.delete(doc(d, "tribes", tid, "members", uid));
  b.update(doc(d, "tribes", tid), { memberCount: increment(-1) });
  const args = ["current", arrayRemove(tid), "lastLeave", tid];
  if (s.current.includes(tid) && (s.teams[team] || 0) >= 1) args.push(new FieldPath("teams", team), s.teams[team] === 1 ? deleteField() : increment(-1));
  b.update(doc(d, "stats", uid), ...args);
  return b.commit();
}
function post(uid, tid, pid, text = "Ki jön meccset nézni?", n = "Fan_" + uid) {
  const d = db(uid), b = writeBatch(d);
  b.update(doc(d, "tribes", tid, "members", uid), { lastPostAt: serverTimestamp() });
  b.set(doc(d, "tribes", tid, "posts", pid), { authorUid: uid, nick: n, type: "text", text, createdAt: serverTimestamp(), replyCount: 0, reportCount: 0, hidden: false });
  return b.commit();
}
function reply(uid, tid, pid, rid, text = "Én!", n = "Fan_" + uid) {
  const d = db(uid), b = writeBatch(d);
  b.update(doc(d, "tribes", tid, "members", uid), { lastPostAt: serverTimestamp() });
  b.update(doc(d, "tribes", tid, "posts", pid), { replyCount: increment(1) });
  b.set(doc(d, "tribes", tid, "posts", pid, "replies", rid), { authorUid: uid, nick: n, text, createdAt: serverTimestamp(), hidden: false });
  return b.commit();
}
function report(uid, tid, pid) {
  const d = db(uid), b = writeBatch(d);
  b.set(doc(d, "tribes", tid, "posts", pid, "reports", uid), { reason: "spam", createdAt: serverTimestamp() });
  b.update(doc(d, "tribes", tid, "posts", pid), { reportCount: increment(1) });
  return b.commit();
}
async function seedTribeBy(uid) { // uid founds Ferencváros · Budapest
  await pin(uid, "Ferencváros"); await nick(uid);
  await createTribe(uid, "Ferencváros");
  return tidOf("Ferencváros");
}
const seedTribe = () => seedTribeBy("alice");

test("pins: verified owner only", async () => {
  await assertSucceeds(pin("alice", "Arsenal"));
  await assertFails(setDoc(doc(db("bob", false), "pins", "bob"), { t: "X", lat: 1, lng: 1, p: "area", ts: serverTimestamp() }));
  await assertFails(setDoc(doc(db("bob"), "pins", "alice"), { t: "X", lat: 1, lng: 1, p: "area", ts: serverTimestamp() }));
});

test("users: username format, profanity, uniqueness, rename, private read", async () => {
  await assertSucceeds(nick("alice", "Gooner_Adam"));
  await assertFails(nick("bob", "x"));
  await assertFails(nick("bob", "<script>"));
  await assertFails(nick("bob", "Gooner Ádám"));            // ASCII only, no spaces
  await assertFails(nick("bob", "fuck_you"));
  await assertFails(nick("bob", "K_u_r_v_a"));               // separators do not hide it
  await assertFails(nick("bob", "gooner_adam"));             // taken (case-insensitive)
  await assertFails(setDoc(doc(db("bob"), "users", "bob"), { nick: "NoClaim", rulesAt: serverTimestamp() })); // must claim the name
  await assertFails(getDoc(doc(db("bob"), "users", "alice")));
  // rename: release the old claim in the same batch, then the old name is free for others
  const d = db("alice"), b = writeBatch(d);
  b.delete(doc(d, "usernames", "gooner_adam"));
  b.set(doc(d, "usernames", "gunner"), { uid: "alice" });
  b.set(doc(d, "users", "alice"), { nick: "Gunner", rulesAt: serverTimestamp() });
  await assertSucceeds(b.commit());
  await assertFails(deleteDoc(doc(db("bob"), "usernames", "gunner")));  // not mine
  await assertSucceeds(nick("bob", "Gooner_Adam"));
});

test("profanity: pins and posts", async () => {
  await assertFails(pin("alice", "Fuck FC"));
  await assertSucceeds(pin("alice", "Ferencváros"));
  await nick("alice"); await createTribe("alice", "Ferencváros");
  const tid = tidOf("Ferencváros");
  await assertFails(post("alice", tid, "p1", "ez kurvára rossz"));
  await assertSucceeds(post("alice", tid, "p2", "Baszk csapat ellen játszunk, fagyi után!"));
});

test("xp: daily once, +50 only on first join, ledger cannot be skipped", async () => {
  await nick("alice");                                       // creates stats with the first daily +10
  if ((await stats("alice")).xp !== 10) throw new Error("daily create");
  await assertFails(updateDoc(doc(db("alice"), "stats", "alice"), { xp: increment(10), lastDailyAt: serverTimestamp() })); // same day
  await assertFails(updateDoc(doc(db("alice"), "stats", "alice"), { xp: 9999 }));
  const tid = await seedTribeBy("bob");
  await pin("alice", "Újpest");
  await assertSucceeds(join("alice", tid));
  if ((await stats("alice")).xp !== 60) throw new Error("join xp");
  await assertSucceeds(leave("alice", tid));
  await assertSucceeds(join("alice", tid));                  // rejoin: no XP
  const s = await stats("alice");
  if (s.xp !== 60 || s.current.length !== 1 || s.teams["Ferencváros"] !== 1) throw new Error("rejoin " + JSON.stringify(s));
  // a member doc without the ledger update is refused
  const d = db("carol"); await nick("carol"); await pin("carol", "Újpest");
  const b = writeBatch(d);
  b.set(doc(d, "tribes", tid, "members", "carol"), { nick: "Fan_carol", role: "member", joinedAt: serverTimestamp() });
  b.update(doc(d, "tribes", tid), { memberCount: increment(1), lastActivityAt: serverTimestamp() });
  await assertFails(b.commit());
});

test("at most 3 teams' tribes", async () => {
  const teams = ["Arsenal", "Chelsea", "Liverpool", "Everton"];
  for (const [i, team] of teams.entries()) { const u = "cap" + i; await pin(u, team); await nick(u); await createTribe(u, team); }
  await nick("dave"); await pin("dave", "Újpest");
  for (const team of teams.slice(0, 3)) await assertSucceeds(join("dave", tidOf(team)));
  await assertFails(join("dave", tidOf("Everton")));          // 4th team
  await assertSucceeds(leave("dave", tidOf("Chelsea")));
  await assertSucceeds(join("dave", tidOf("Everton")));       // a slot freed up
});

test("referral: +100 to the inviter once, never self", async () => {
  const tid = await seedTribeBy("alice");
  await nick("bob"); await pin("bob", "Újpest");
  await assertFails(join("bob", tid, "Fan_bob", "bob"));     // self-referral
  await assertSucceeds(join("bob", tid, "Fan_bob", "alice"));
  let a = await stats("alice"); if (a.xp !== 60 + 100 || a.refs !== 1) throw new Error("ref " + JSON.stringify(a));
  // forging credit without a referred join is refused
  await assertFails(updateDoc(doc(db("bob"), "stats", "alice"), { xp: increment(100), refs: increment(1) }));
  await leave("bob", tid);
  await assertSucceeds(join("bob", tid, "Fan_bob", "alice")); // rejoin: no second credit (helper skips it)
  const d = db("bob"), b = writeBatch(d);                     // and a forced second credit fails
  b.delete(doc(d, "tribes", tid, "members", "bob"));
  b.update(doc(d, "tribes", tid), { memberCount: increment(-1) });
  b.update(doc(d, "stats", "bob"), "current", arrayRemove(tid), "lastLeave", tid, new FieldPath("teams", "Ferencváros"), deleteField());
  await b.commit();
  const b2 = writeBatch(d);
  b2.set(doc(d, "tribes", tid, "members", "bob"), { nick: "Fan_bob", role: "member", joinedAt: serverTimestamp(), ref: "alice" });
  b2.update(doc(d, "tribes", tid), { memberCount: increment(1), lastActivityAt: serverTimestamp() });
  b2.update(doc(d, "stats", "bob"), new FieldPath("teams", "Ferencváros"), increment(1), "current", arrayUnion(tid), "lastJoin", tid);
  b2.update(doc(d, "stats", "alice"), { xp: increment(100), refs: increment(1) });
  await assertFails(b2.commit());
  a = await stats("alice"); if (a.refs !== 1) throw new Error("double credit");
});

test("tribe name: optional, clean, 3+ chars", async () => {
  await pin("alice", "Arsenal"); await nick("alice");
  await assertFails(createTribe("alice", "Arsenal", BUD, "Fan_alice", tidOf("Arsenal"), { name: "Kurva jó" }));
  await assertFails(createTribe("alice", "Arsenal", BUD, "Fan_alice", tidOf("Arsenal"), { name: "ab" }));
  await assertSucceeds(createTribe("alice", "Arsenal", BUD, "Fan_alice", tidOf("Arsenal"), { name: "Budapesti Ágyúsok" }));
});

test("join needs accepted community rules", async () => {
  const tid = await seedTribe();
  await pin("bob", "Újpest"); await nick("bob", "Fan_bob", false);
  await assertFails(join("bob", tid));
  await assertSucceeds(setDoc(doc(db("bob"), "users", "bob"), { nick: "Fan_bob", rulesAt: serverTimestamp() }));
  await assertSucceeds(join("bob", tid));
});

test("tribe create: own pin team, nearby, deterministic id", async () => {
  await pin("alice", "Ferencváros"); await nick("alice");
  await assertFails(createTribe("alice", "Arsenal"));                                   // not my team
  await assertFails(createTribe("alice", "Ferencváros", BUD, "Fan_alice", "R1_whatever")); // wrong id
  await assertFails(createTribe("alice", "Ferencváros", { ...BUD, cityOsm: "R65606", city: "London", ...LON })); // far away
  await assertFails(createTribe("alice", "Ferencváros", BUD, "Impostor"));              // nick must match profile
  await assertSucceeds(createTribe("alice", "Ferencváros"));
  await assertFails(createTribe("alice", "Ferencváros"));                               // already exists
});

test("join: nearby pin or fresh presence; once only", async () => {
  const tid = await seedTribe();
  await nick("bob"); await pin("bob", "Arsenal", LON);
  await assertFails(join("bob", tid));                     // pin in London, tribe in Budapest
  await here("bob", BUD);
  await assertSucceeds(join("bob", tid));                  // travelling: checked in at Budapest
  await assertFails(join("bob", tid));                     // already a member
  await nick("carol"); await pin("carol", "Újpest");
  await assertSucceeds(join("carol", tid));                // local, any team may join
  const t = await getDoc(doc(db("carol"), "tribes", tid));
  if (t.data().memberCount !== 3) throw new Error("memberCount " + t.data().memberCount);
  await nick("dave");
  await assertFails(join("dave", tid));                    // no pin, no presence
});

test("join: count must move with the member doc", async () => {
  const tid = await seedTribe();
  await nick("bob"); await pin("bob", "Újpest");
  const d = db("bob");
  await assertFails(setDoc(doc(d, "tribes", tid, "members", "bob"), { nick: "Fan_bob", role: "member", joinedAt: serverTimestamp() }));
  await assertFails(updateDoc(doc(d, "tribes", tid), { memberCount: increment(5) }));
  const b = writeBatch(d);
  b.set(doc(d, "tribes", tid, "members", "bob"), { nick: "Fan_bob", role: "captain", joinedAt: serverTimestamp() });
  b.update(doc(d, "tribes", tid), { memberCount: increment(1), lastActivityAt: serverTimestamp() });
  await assertFails(b.commit());                           // cannot self-promote to captain
});

test("posts: members only, nick checked, 20 s rate limit", async () => {
  const tid = await seedTribe();
  await assertSucceeds(post("alice", tid, "p1"));
  await assertFails(post("alice", tid, "p2"));             // too soon
  await nick("bob");
  await assertFails(post("bob", tid, "p3"));               // not a member
  await pin("bob", "Újpest"); await join("bob", tid);
  await assertFails(post("bob", tid, "p4", "hi", "Someone"));      // wrong nick
  await assertFails(post("bob", tid, "p5", "x".repeat(501)));      // too long
  await assertSucceeds(post("bob", tid, "p6"));
});

test("replies, reports, captain hide, leave", async () => {
  const tid = await seedTribe();
  await post("alice", tid, "p1");
  await nick("bob"); await pin("bob", "Újpest"); await join("bob", tid);
  await assertSucceeds(reply("bob", tid, "p1", "r1"));
  await assertSucceeds(report("bob", tid, "p1"));
  await assertFails(report("bob", tid, "p1"));             // one report per user
  await assertFails(updateDoc(doc(db("bob"), "tribes", tid, "posts", "p1"), { hidden: true }));   // members cannot hide
  await assertSucceeds(updateDoc(doc(db("alice"), "tribes", tid, "posts", "p1"), { hidden: true })); // captain can
  await assertFails(updateDoc(doc(db("bob"), "tribes", tid, "posts", "p1"), { text: "edited" }));
  await assertSucceeds(leave("bob", tid));
  const t = await getDoc(doc(db("alice"), "tribes", tid));
  if (t.data().memberCount !== 1) throw new Error("memberCount " + t.data().memberCount);
});
