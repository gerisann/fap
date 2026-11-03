/* Auth (Google + email link) and the shared pin store. Loaded lazily by main.js after the map is up.
   Public web config only; access is enforced by firestore.rules. */
import { initializeApp } from "firebase/app";
import {
  getAuth, onAuthStateChanged, GoogleAuthProvider, signInWithPopup, signInWithRedirect, signOut as fbSignOut,
  sendSignInLinkToEmail, isSignInWithEmailLink, signInWithEmailLink, browserLocalPersistence, setPersistence,
} from "firebase/auth";
import { getFirestore, collection, doc, onSnapshot, setDoc, deleteDoc, serverTimestamp } from "firebase/firestore";

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
setPersistence(auth, browserLocalPersistence).catch(() => {});

const EMAIL_KEY = "tm.email";

export const onUser = fn => onAuthStateChanged(auth, fn);

export async function signInGoogle() {
  const p = new GoogleAuthProvider();
  try { await signInWithPopup(auth, p); }
  catch (e) { if (e.code === "auth/popup-blocked" || e.code === "auth/operation-not-supported-in-this-environment") await signInWithRedirect(auth, p); else throw e; }
}

export async function sendEmailLink(email) {
  await sendSignInLinkToEmail(auth, email, { url: location.origin + "/?signin=1", handleCodeInApp: true });
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
  const u = new URL(location.href); for (const k of [...u.searchParams.keys()]) if (k !== "lang") u.searchParams.delete(k);
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
