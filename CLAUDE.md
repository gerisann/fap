# FAP – Fun Map

Anonim szurkolói világtérkép. Bárki bejelöli, hol él vagy tartózkodik, és melyik focicsapatnak szurkol. A térképen csak a csapat látszik, név soha.

- Élő oldal: https://gerisann.github.io/fap/ (GitHub Pages, `main` ág, gyökér)
- Tulajdonos: Geri (gerisann). A felhasználói felület nyelve magyar.

## Alapelvek (ezekhez tartsd magad)

- **Anonimitás az első.** Pinről csak a csapat és a pontosság látszik. Személyes adat (név, e-mail, pontos cím) soha nem kerül publikus adatba.
- **A pontosságot a felhasználó választja**, és csak az elmosott koordinátát mentjük:
  - Környék (alapértelmezett): véletlen 250–600 m eltolás
  - Város: ~0,05°-os (kb. 5 km) rácsra igazítás
  - Pontos: változatlan
  Az elmosás a kliensen történik, mentés előtt (`blur()`).
- **Bármilyen csapat választható:** előtöltött lista (`src/teams.js`, címerszínekkel) + szabad beírás, aliasokkal (fradi → Ferencváros stb.).

## Funkciók (jelenleg)

- Mapbox GL JS v3.7, `light-v11` / `dark-v11` stílus, `language: "hu"`, globe nézet.
- **Pinek nézet:**
  - minden csapat: egy klaszterforrás, `clusterProperties` a top 40 csapat darabszámával → HTML-markeres fánkdiagram (összlétszám középen);
  - egy csapatra szűrve: külön klaszterforrás a csapat színével, számozott gömbök, zoomra szétválnak.
- **Heatmap nézet** (zoomfüggő súly, hogy kizoomolva ne égjen ki).
- Bejelölés: csapat (combobox) → hely (térképkattintás / húzható jelölő / városlista) → pontosság → mentés.
- Világos/sötét mód: alapból `prefers-color-scheme`, a választás `localStorage`-ban (`fap.theme`).
- 24 000 generált, seedelt demó szurkoló (`makeDemo`, `src/cities.js` súlyai alapján), kapcsolható.
- **Nincs még backend:** a saját pin csak `localStorage`-ban él (`fap.mypin`).

## Fájlok és build

- `index.html` – **generált**, ne kézzel szerkeszd.
- `src/src.html` – a forrás (HTML + CSS + JS egyben). Helyőrzők: `/*__TEAMS__*/`, `/*__CITIES__*/` stb.
- `src/teams.js` – `[név, ország, szín]`. `src/cities.js` – demó városok, helyi csapatarányok, `GLOBAL` klubok.
- `src/build.py` – `cd src && python3 build.py` → újragenerálja a `../index.html`-t (Mapbox-verzió). Egy claude.ai artifact-változatot is tud építeni, ha a MapLibre/Natural Earth függőségek elérhetők; ez itt kihagyható.
- Ha nagyobb lesz, érdemes átállni rendes projektre (pl. Vite + modulok); a funkcionalitást és a dizájnt ilyenkor is meg kell tartani.

## Dizájnszabályok

Minimalista, modern, ne nézzen ki „sablonosnak”.
- **Színek:** 3 fő szín + 1 muted. Világos: ink `#16181c`, paper `#ffffff`, cobalt `#3355ff`, mute `#8b9099`. Sötét: `#eceef1` / `#1b1d21` / `#6680ff` / `#7c828b`. Minden szín CSS tokenből jön; a térképrétegek színei a JS `PAL` objektumból.
- **Fontok:** Bricolage Grotesque (logó, címek), Instrument Sans (szöveg).
- Szegélyek és vonalak helyett tér és lágy árnyék; pill formák; lekerekítés 26/16/11 px.
- Kevés magyarázó szöveg. Mobilon: a kártya felső sáv, a csapatlista vízszintes chip-sor, a bejelölő panel alulról jön fel.

## Mapbox token

- Publikus `pk.` token, az `index.html`-be (build.py-ba) beégetve; a Mapbox fiókban URL-korlátozva `https://gerisann.github.io`-ra.
- A GitHub push protection secretnek jelöli: az első pushnál bypassolva lett. Új domainnél a korlátozást bővíteni kell.
- Ne commitolj `sk.` (titkos) tokent.

## Következő lépések (terv)

1. **Közös adatbázis** (pl. Supabase + PostGIS): `pins` tábla, egy pin / felhasználó, mindenki olvassa, csak a sajátját írja (RLS). Csak elmosott koordináta + csapat + pontosság + időbélyeg.
2. **Belépés** (e-mail magic link / Google), névtelen megjelenítéssel.
3. **Moderálás és visszaélés elleni védelem** (rate limit, csapatnév-szűrés, spam).
4. **GDPR:** adatvédelmi tájékoztató, saját pin törlése, adatminimalizálás.
5. Csapatadatbázis bővítése (nagy klublista, logók jogtiszta forrásból), statisztikák (top csapatok városonként).
6. Saját domain.
