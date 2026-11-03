/* Profanity filter (hu / en / es). KEEP IN SYNC with badText() / badName() in firestore.rules:
   the rules are the real gate, this only gives instant feedback. Stems are matched at a word start
   (so suffixes like "kurvára" are caught) and chosen to avoid everyday words (baszk, szoptat, fagyi…). */

export const STEMS = [
  // hu
  "fasz", "geci", "kurv", "picsa", "picsá", "punci", "buzi", "köcsög", "kocsog", "baszd", "baszom", "baszott", "bazdmeg", "bazmeg",
  "ribanc", "szopd", "szopj", "szopó", "kibasz", "elbasz", "megbasz", "segg",
  // en
  "fuck", "shit", "cunt", "bitch", "nigg", "whore", "slut", "asshole", "motherf", "retard", "faggot", "rapist",
  // es
  "puta", "mierda", "cabrón", "cabron", "gilipoll", "pendej", "maricón", "maricon", "joder", "coño", "verga", "culero",
  // hate / extremism
  "nazi", "hitler",
];

// usernames are ASCII-only, so plain substring matching on the unaccented stems
export const NAME_STEMS = STEMS.filter(s => /^[a-z]+$/.test(s));

const fold = s => s.toLowerCase()
  .replace(/[0@4]/g, m => ({ "0": "o", "@": "a", "4": "a" })[m])
  .replace(/[1!|]/g, "i").replace(/3/g, "e").replace(/[5$]/g, "s").replace(/7/g, "t");
const textRe = new RegExp("(^|[^\\p{L}])(" + STEMS.join("|") + ")", "u");
const strip = s => s.normalize("NFD").replace(/[̀-ͯ]/g, "");

export function isProfane(text) {
  const t = fold(text);
  return textRe.test(t) || textRe.test(strip(t));
}
export function isBadName(name) {
  const n = fold(name).replace(/[_-]/g, "");
  return NAME_STEMS.some(s => n.includes(s));
}
