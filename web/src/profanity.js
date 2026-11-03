/* Profanity filter (hu / en / es). The word lists below are the single source of truth:
   `npm run sync:profanity` copies them into firestore.rules (the real gate); this module only gives
   instant feedback. Everything is compared after fold(): lower case, digits/symbols back to letters
   (f4sz → fasz), accents removed (köcsög → kocsog), so the lists are plain ASCII.
   STEMS match at the start of a word (so suffixes like "kurvára" are caught);
   WORDS match only as whole words (szar ≠ szarvas, fos ≠ foszfor). Both are chosen to leave everyday
   words alone (baszk, szoptatás, fagyi, Marica, Dickson, basszus, folleto, conocer…). */

export const STEMS = [
  // hu
  "fasz", "geci", "kurv", "picsa", "punci", "buzi", "kocsog", "segg", "ribanc", "kibasz", "elbasz", "megbasz", "lebasz",
  "baszd", "baszom", "baszott", "baszni", "baszik", "baszas", "baszol", "basztam", "bazdmeg", "bazmeg", "baszki",
  "szopd", "szopj", "szopas", "faszkalap",
  // en
  "fuck", "fuq", "phuck", "shit", "cunt", "bitch", "biatch", "nigg", "whore", "slut", "asshole", "arsehole",
  "motherf", "retard", "faggot", "rapist", "wanker", "wanking", "dickhead", "bollock", "bullshit", "jackass", "dumbass", "douchebag", "twat", "tranny",
  // es
  "puta", "mierd", "cabron", "gilipoll", "pendej", "maricon", "joder", "jodid", "culero", "capull", "cojon", "hijoputa", "hijueputa",
  "follar", "follando", "chingar", "chingad", "pinche", "huevon", "conazo", "mamon", "sudaca", "malparid",
  // hate / extremism
  "hitler", "siegheil",
];
export const WORDS = [
  // hu
  "szar", "fos", "cici", "csocs", "basz", "bassz",
  // en
  "dick", "cock", "prick", "pussy", "fag", "piss", "wtf", "stfu", "kys", "kkk", "coon", "spic", "kike", "chink", "paki",
  // es
  "verga", "polla", "culo", "hdp", "ptm", "chinga",
  // hate / extremism (whole words, so "Nazionale" stays fine)
  "nazi", "nazik", "nazis", "nazist", "naci", "nacis", "sieg heil",
];

// usernames are matched as substrings (separators ignored), so only the unambiguous stems are used there
export const NAME_STEMS = STEMS;

export function fold(s) {
  return s.toLowerCase()
    .replace(/0/g, "o").replace(/[1!|]/g, "i").replace(/3/g, "e").replace(/[4@]/g, "a").replace(/[5$]/g, "s").replace(/7/g, "t")
    .normalize("NFD").replace(/[̀-ͯ]/g, "");
}
const stemRe = new RegExp("(^|[^a-z])(" + STEMS.join("|") + ")");
const wordRe = new RegExp("(^|[^a-z])(" + WORDS.join("|") + ")([^a-z]|$)");

export const isProfane = text => { const f = fold(text); return stemRe.test(f) || wordRe.test(f); };
export const isBadName = name => { const f = fold(name).replace(/[_-]/g, ""); return NAME_STEMS.some(s => f.includes(s)); };
