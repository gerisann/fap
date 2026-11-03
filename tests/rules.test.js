// Firestore security rules, run against the emulator: npm run test:rules
import { test, before, after, beforeEach } from "node:test";
import { readFileSync } from "node:fs";
import { initializeTestEnvironment, assertSucceeds, assertFails } from "@firebase/rules-unit-testing";
import { doc, setDoc, getDoc, deleteDoc, writeBatch, serverTimestamp, increment, updateDoc } from "firebase/firestore";

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
function nick(uid, n = "Fan_" + uid, rules = true) { // claim the username + write the profile in one batch
  const d = db(uid), b = writeBatch(d);
  b.set(doc(d, "usernames", n.toLowerCase()), { uid });
  b.set(doc(d, "users", uid), rules ? { nick: n, rulesAt: serverTimestamp() } : { nick: n });
  return b.commit();
}
const here = (uid, at) => setDoc(doc(db(uid), "presence", uid), { lat: at.lat, lng: at.lng, ts: serverTimestamp() });

function createTribe(uid, team, c = BUD, n = "Fan_" + uid, tid = tidOf(team, c)) {
  const d = db(uid), b = writeBatch(d);
  b.set(doc(d, "tribes", tid), { team, city: c.city, cityOsm: c.cityOsm, country: c.country, lat: c.lat, lng: c.lng, memberCount: 1, createdAt: serverTimestamp(), lastActivityAt: serverTimestamp() });
  b.set(doc(d, "tribes", tid, "members", uid), { nick: n, role: "captain", joinedAt: serverTimestamp() });
  return b.commit();
}
function join(uid, tid, n = "Fan_" + uid) {
  const d = db(uid), b = writeBatch(d);
  b.set(doc(d, "tribes", tid, "members", uid), { nick: n, role: "member", joinedAt: serverTimestamp() });
  b.update(doc(d, "tribes", tid), { memberCount: increment(1), lastActivityAt: serverTimestamp() });
  return b.commit();
}
function leave(uid, tid) {
  const d = db(uid), b = writeBatch(d);
  b.delete(doc(d, "tribes", tid, "members", uid));
  b.update(doc(d, "tribes", tid), { memberCount: increment(-1) });
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
async function seedTribe() { // alice founds Ferencváros · Budapest
  await pin("alice", "Ferencváros"); await nick("alice");
  await createTribe("alice", "Ferencváros");
  return tidOf("Ferencváros");
}

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
