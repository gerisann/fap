# TribeMap (korábban FAP – Fun Map)

Anonim szurkolói világtérkép. Bárki bejelöli, hol él vagy tartózkodik, és melyik focicsapatnak szurkol. A térképen csak a csapat látszik, név soha.

- Élő oldal: https://tribemap.web.app (Firebase Hosting, projekt: `tribemap-app`, oldal: `tribemap`)
- A régi https://gerisann.github.io/fap/ átirányít (a gyökér `index.html` csak átirányító oldal).
- Tulajdonos: Geri (gerisann). A felület háromnyelvű: hu / en / es.
- Terv és ütemezés: `docs/terv.md`.

## Alapelvek (ezekhez tartsd magad)

- **Anonimitás az első.** Pinről csak a csapat és a pontosság látszik. Személyes adat (név, e-mail, pontos cím) soha nem kerül publikus adatba.
- **A pontosságot a felhasználó választja**, és csak az elmosott koordinátát mentjük:
  - Környék (alapértelmezett): véletlen 250–600 m eltolás
  - Város: ~0,05°-os (kb. 5 km) rácsra igazítás
  - Pontos: változatlan
  Az elmosás a kliensen történik, mentés előtt (`blur()`).
- **Bármilyen csapat választható:** előtöltött lista (`src/teams.js`, címerszínekkel) + szabad beírás, aliasokkal (fradi → Ferencváros stb.).

## Funkciók (jelenleg)

- MapLibre GL JS v6 + OpenFreeMap (`positron` / `dark`), globe nézet. A stílust a `web/src/basemap.js` tölti be, átszínezi a tokenekre, és a feliratokat `name:<nyelv>` mezőre állítja.
- **Pinek nézet:**
  - minden csapat: egy klaszterforrás, `clusterProperties` a top 40 csapat darabszámával → HTML-markeres fánkdiagram (összlétszám középen);
  - csapatszűrő (max. 5, `MAX_TEAMS`): külön `sel` klaszterforrás a kiválasztott csapatok darabszámával → ugyanolyan fánk, csak azokkal a színekkel.
- Csapatlista: top 10, „Összes csapat” gomb, kereső (aliasokkal); a számok a kiválasztott területre vonatkoznak.
- Területszűrő: Világ / Ország / Város (Photon-keresés → Nominatim-körvonal, választásonként egy kérés, `web/src/area.js`) / Sugár (letett, húzható középpont + 1–200 km). Minden statisztika és réteg a `scoped()` pontokból dolgozik.
- Mobilon a felső panel alapból összecsukott; a fogantyúval vagy fel-le húzással nyitható/zárható (`tm.board`).
- **Heatmap nézet** (zoomfüggő súly, hogy kizoomolva ne égjen ki).
- Bejelölés: csapat (combobox) → hely (térképkattintás / húzható jelölő / városkereső + opcionális utca-házszám, Photon) → pontosság → mentés → belépés, ha még nincs.
- Világos/sötét mód: alapból `prefers-color-scheme`, a választás `localStorage`-ban (`tm.theme`). Nyelv: `?lang=` → `tm.lang` → böngésző → `en`.
- 24 000 generált, seedelt demó szurkoló (`makeDemo`, a `web/src/data/cities.js` súlyai alapján), kapcsolható.
- **Backend (F1, számlázás nélküli változat):** Firebase Auth (Google + e-mail link) + Firestore `pins/{uid}` (`web/src/firebase.js`, lustán betöltve). Írni csak ellenőrzött e-mailes, saját uid-re lehet; mezővalidálás és 30 mp-es rate limit a `firestore.rules`-ban. Belépés előtt csak az elmosott piszkozat várakozik (`tm.draft`). Az olvasás egyelőre közvetlen `onSnapshot`; ha lesz számlázás, a Cloud Run + CDN-cache váltja (docs/terv.md).
- **Fiókblokk** (`#account`): asztalon jobb felső kártya, mobilon a logó melletti avatarral nyíló alsó panel. Itt van a belépés, a saját pin (Megmutatom / Módosítom / Törlöm), a zászlós nyelvválasztó és a téma. Ha van pin, a fő gomb „Saját pinem” (odazoomol). Módosításkor, ha a hely és a pontosság nem változik, a tárolt (már elmosott) pont marad, nincs újraelmosás.
- **Tribe-ok (T1, `web/src/tribes.js`, terv: `docs/tribes.md`):** csapat + város közösség. Id: `<város OSM-id>_<csapat-slug>`. Létrehozni csak a saját pin csapatára, csatlakozni bárkinek, de mindkettőt **csak a közelben** (~50 km a pintől vagy egy 72 órás „Itt vagyok most” `presence/{uid}` jelzéstől; a doboz a rules `close()`-ában és a JS `nearBox()`-ában ugyanaz, együtt módosítsd). Becenév + közösségi szabályok (16+) a `users/{uid}`-ben. Hírfolyam: posztok, válaszok, jelentés (3 után rejtett), kapitányi elrejtés, 20 mp-es rate limit. Meghívó link: `/t/<id>` (Hosting rewrite).
- **Mérés:** minden esemény a `track()`-en át megy (`web/src/analytics.js`) → `dataLayer` → GTM (`VITE_GTM_ID`). Consent Mode v2, az analitika hozzájárulásig tiltva. A `track()` kiszűri a koordinátát, az uid-et és az e-mailt; ezt ne kerüld meg. A bejelölő panel `data-clarity-mask`.

## Fájlok és build

- Vite, a gyökér a `web/`: `web/index.html`, `web/src/main.js` (térkép + UI), `i18n.js` + `locales/{hu,en,es}.js`, `basemap.js`, `analytics.js`, `data/` (`teams.js` `[név, ország, szín]`, `cities.js`, `demo.js` a `blur()`-ral).
- Új felirat: kulcs mindhárom locale-ba, a HTML-ben `data-i18n` / `data-i18n-attr`, a JS-ben `t()`.
- Parancsok (PowerShell, a repo gyökerében): `npm.cmd run dev`, `npm.cmd run build`, `npm.cmd run deploy` (build + `firebase deploy --only hosting:app`).
- **Szabálymódosítás után kötelező:** `npm.cmd run test:rules` (emulátor, `tests/rules.test.js`), deploy: `firebase.cmd deploy --only firestore:rules`.
- Bejelentkezett folyamatok helyi tesztje: `npm.cmd run emulators` + `http://localhost:5173/?emu` (Auth + Firestore emulátor, éles adat nem érintett). Az e-mail-link az emulátor kimenetében jelenik meg.
- MapLibre v6 csak ESM; Vite alatt kötelező a `setWorkerUrl(...?worker&url)`, enélkül nem jönnek a csempék.
- A gyökér `index.html` csak a GitHub Pages átirányítója, nem az app.

## Dizájnszabályok

Minimalista, modern, ne nézzen ki „sablonosnak”.
- **Színek:** 3 fő szín + 1 muted. Világos: ink `#16181c`, paper `#ffffff`, cobalt `#3355ff`, mute `#8b9099`. Sötét: `#eceef1` / `#1b1d21` / `#6680ff` / `#7c828b`. Minden szín CSS tokenből jön; a térképrétegek színei a JS `PAL` objektumból.
- **Fontok:** Bricolage Grotesque (logó, címek), Instrument Sans (szöveg).
- Szegélyek és vonalak helyett tér és lágy árnyék; pill formák; lekerekítés 26/16/11 px.
- Kevés magyarázó szöveg. Mobilon: a kártya felső sáv, a csapatlista vízszintes chip-sor, a bejelölő panel alulról jön fel.

## Kulcsok

- A MapLibre + OpenFreeMap nem igényel kulcsot. A régi Mapbox `pk.` token kikerült a kódból (a git-történetben még benne van; a Mapbox-fiókban visszavonható).
- Csak publikus azonosítók kerülhetnek a kódba / `.env.local`-ba (GTM-ID, Firebase webconfig). Titkos kulcsot ne commitolj.

## Következő lépések (terv)

Részletesen: `docs/terv.md` (F0–F5). F0 kész (Vite, MapLibre, i18n, mérési réteg, deploy).
1. **Közös adatbázis:** Firestore `pins/{uid}` (egy pin / fiók), írás csak a Cloud Run API-n át, olvasás a CDN-ről cache-elt `/api/pins`-ből. Csak elmosott koordináta + csapat + pontosság + időbélyeg.
2. **Belépés:** Firebase Auth, Google + e-mail link, névtelen megjelenítéssel.
3. **Moderálás és visszaélés elleni védelem** (rate limit, csapatnév-szűrés, spam).
4. **GDPR:** adatvédelmi tájékoztató, saját pin törlése, adatminimalizálás.
5. Csapatadatbázis bővítése (nagy klublista, logók jogtiszta forrásból), statisztikák (top csapatok városonként).
6. Saját domain.
