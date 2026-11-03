# TribeMap – terv

> Döntések (2026-11-03): név **TribeMap**, cím **tribemap.web.app** (projekt: `tribemap-app`),
> térkép **MapLibre GL v5 + OpenFreeMap**, belépés Google + e-mail link, teljes mérés hozzájárulással,
> a GitHub Pages átirányít.

## 1. Architektúra (nagy forgalomra)

```
böngésző ──► Firebase Hosting (CDN, statikus Vite-build)
   │            └─ /api/** rewrite ──► Cloud Run „fap-api” (Node, europe-west1)
   │                                        ├─ Firestore (pins/{uid})
   ├─ Firebase Auth (Google + e-mail link)  └─ Firebase Admin: tokenellenőrzés
   ├─ App Check (reCAPTCHA Enterprise)
   ├─ MapLibre GL + OpenFreeMap (csempék, kulcs és díj nélkül)
   └─ Tag Manager ──► GA4, Clarity (csak hozzájárulás után)
```

- **Egy fiók = egy pin:** a Firestore-dokumentum azonosítója a `uid` (`pins/{uid}`), ezért egy fiókhoz
  szerkezetileg csak egy pin tartozhat. A kliens nem ír közvetlenül a Firestore-ba, csak az API-n át
  (validálás, rate limit, csapatnév-szűrés).
- **Olvasás nem a Firestore-ból megy látogatónként.** Ha 100 000 látogató egyenként 10 000 pint olvasna,
  az 1 milliárd dokumentumolvasás (~600 USD). Helyette:
  `GET /api/pins` → a Cloud Run memóriában tartja a pineket (induláskor egy teljes beolvasás, utána
  30 mp-enként csak az `updatedAt > utolsó` változások), tömör tömbként adja vissza, és
  `Cache-Control: s-maxage=60` mellett a Hosting CDN szolgálja ki. A költség így a látogatószámtól
  gyakorlatilag független.
- **Végpontok:** `GET /api/pins`, `GET /api/stats`, `PUT /api/me/pin`, `DELETE /api/me/pin`,
  `DELETE /api/me` (GDPR: fiók és adatok törlése).
- **Adatmodell** – `pins/{uid}`: `team`, `teamKey`, `lat`, `lng` (már elmosva), `prec`, `country`,
  `updatedAt`, `deleted` (tombstone a szinkronhoz). Név és e-mail nincs benne.
- **Költségkorlát:** Cloud Run `max-instances`, költségvetés-riasztás, App Check kötelező az írásnál.
- **Térkép:** a Mapbox térképbetöltésenként számlázna, ezért **MapLibre GL v5** (globe) +
  **OpenFreeMap** csempék. Ez ingyenes, nincs kulcs, de nincs rá SLA sem. Ha kell, később ugyanazzal a
  kóddal átállhatunk MapTilerre vagy saját PMTiles-ra Cloud Storage-ból. A feliratnyelv a
  csempék `name:hu` / `name:en` / `name:es` mezőiből jön.

## 1/b. Mérés és statisztika

Cél: minden lekérdezhető legyen (viselkedés, idő, kattintás, forrás), de az anonimitás és a GDPR
sérülése nélkül.

| Réteg | Mit ad | Kinek a lépése |
|---|---|---|
| Saját `track()` réteg → `dataLayer` | egységes eseménynevek; minden UI-esemény egy helyen | kód |
| **Google Tag Manager** | ide köt be minden további eszközt, kódváltozás nélkül | konténer létrehozása: te |
| **GA4** (a Firebase-projekthez kötve) | forrás, munkamenet, idő, eszköz, tölcsér, megtartás | bekapcsolás a Firebase-konzolon: te |
| **GA4 → BigQuery napi export** | nyers eseményszintű adat, SQL-lel bármi lekérdezhető | számlázás kell |
| **Microsoft Clarity** | hőtérkép, görgetés, munkamenet-felvétel, „rage click” | fiók: te |
| **Search Console** | keresési megjelenések, kulcsszavak, indexelés | ellenőrzés meta taggel: te + kód |
| **Cloud Run strukturált log → BigQuery** | szerveroldali események (mentés, törlés, hibák, rate limit) | számlázás kell |
| **Looker Studio** (a SiteKit megfelelője) | egy irányítópult a fentiekből | F5 |

**Eseményterv (első kör):** `map_move`, `map_zoom` (zoomszint-sávokra), `view_change` (pinek/heatmap),
`team_filter`, `cluster_click`, `pin_flow_start`, `pin_team_pick`, `pin_place_method`
(térkép/városlista/helymeghatározás), `pin_precision`, `pin_save`, `pin_delete`, `theme_change`,
`lang_change`, `demo_toggle`, `login_start`, `login_success`, `share`. Az idő és a forrás a GA4-ből jön
automatikusan.

**Adatvédelmi szabályok (kötelező):**
- Hozzájárulási sáv saját megoldással, **Consent Mode v2** mellett. Elutasításnál a GA4 cookie nélkül,
  modellezett pingekkel megy, a Clarity pedig nem tölt be.
- **Koordináta, uid, e-mail soha nem kerül analitikába.** A csapatnév mehet, mert publikus adat.
- Clarity: a bejelölő panel és minden beviteli mező maszkolva (`data-clarity-mask`). A térkép
  canvasát a Clarity nem rögzíti.
- Adatvédelmi tájékoztató, amely felsorolja az eszközöket; adatmegőrzés: GA4 14 hónap.

## 2. Kód-átállás

- **Vite** + ES-modulok: `src/map/`, `src/ui/`, `src/i18n/`, `src/data/`, `src/api/`. A dizájntokenek és a
  `PAL` maradnak; a `build.py` megszűnik.
- **i18n saját megoldással** (nincs külső könyvtár): `locales/{hu,en,es}.json`; a nyelv sorrendje
  `?lang=` → `localStorage` (`fap.lang`) → böngésző → `en`. A `<html lang>` és a Mapbox `language`
  követi a választást. A csapataliasok nyelvenként bővíthetők (Barça, Real, Fradi…).
- A demótartalom marad, kapcsolható, „demó” jelöléssel.
- GitHub Pages → átirányítás az új címre, ha az él.
- A donutmarkereket HTML-markerek helyett `map.addImage`-dzsel előre renderelt canvasképekre és
  symbol-rétegre cseréljük – nagy pinszámnál ez a legnagyobb teljesítménynyereség.

## 3. „Focisabb”, játékszerű térkép – ötletek

Jelölés: ★ = nagy hatás / kevés munka, ◆ = nagy hatás / sok munka.

**Látvány és mozgás**
- ★ **Intro:** lassan forgó földgömb (sötét módban csillagokkal), az első érintésre ráközelít a
  felhasználó környékére.
- ★ **Gólöröm mentéskor:** konfetti a csapat színeiben, a saját pin „becsapódik”, és hullám fut körülötte.
- ★ **Élő pulzus:** az új pinek egy pillanatra felvillannak (radar-hullám), oldalt pedig egy
  „élő közvetítés” sáv: *„+1 Fradi-szurkoló, Bécs”*.
- ◆ **Területfoglalás-mód:** hatszögrács, minden cella a domináns csapat színét kapja. Kérdés: ki
  uralja a várost? Zoomra finomodik (ország → város → kerület).
- ◆ **3D stadionfények:** a nagy klaszterek csapatszínű fényoszlopként (fill-extrusion) emelkednek ki,
  ha a kamera megdől.
- ★ **Stadionréteg:** a Mapbox Streets stadion-POI-jai ikonnal, kattintásra a környék szurkolói.
- ◆ **Diaszpóraívek:** ívek a klub otthonától a távoli szurkolókig (pl. „a legmesszebbi Fradi-drukker”).
  Ehhez a `teams.js` klubjai mellé otthoni koordináta kell.
- ★ **Túrák:** „Repülj végig a Barça-szurkolókon” – automatikus kamerapálya a csapat legnagyobb
  gócpontjain.

**Adat és szűrés**
- ★ Szűrők: csapat, ország, bajnokság, pontosság, „csatlakozott az elmúlt 7 napban”, demó be/ki.
- ★ **Élő nézetstatisztika:** mozgatás közben frissülő toplista arról, ami épp látszik.
- ◆ **Rangadó-nézet:** két csapat összevetése osztott színezéssel és arányokkal régiónként.
- ★ Kereső: város vagy csapat → ráközelítés (helyi városlistából, hogy ne legyen geokódolási költség).
- Városbajnok, sokszínűségi index, országos ranglisták.

**Játékosítás**
- ★ Jelvények: „Első szurkoló a városban”, „Úttörő”, „Idegenlégiós” (500 km-nél messzebb a klubtól).
- ◆ **Megosztható kártya** (OG-kép): *„1 vagyok a 312 bécsi Fradi-szurkolóból”*.

## 4. Ütemezés

| Fázis | Tartalom | Kész, ha |
|---|---|---|
| F0 | Firebase/GCP projekt, Vite-átállás funkcióváltozás nélkül, deploy | az új cím ugyanazt tudja, mint a mostani oldal |
| F1 | Belépés, API, Firestore, „1 fiók = 1 pin”, saját pin törlése | két böngészőből látszik egymás pinje |
| F2 | hu / en / es | minden felirat fordítva, nyelvváltó |
| F3 | Látványcsomag 1: intro, gólöröm, pulzus, stadionok, symbol-donutok | 60 fps közepes mobilon |
| F4 | Adatcsomag: szűrők, nézetstatisztika, kereső, területfoglalás | – |
| F5 | Moderálás, adatvédelmi tájékoztató, jelvények, megosztókártya, saját domain | – |

## 5. Amit őszintén tudni kell

- **„Egy ember = egy szurkoló” 100%-ban nem garantálható.** Egy fiókhoz egy pin tartozhat, de egy ember
  több Google-fiókot is nyithat. A szigorúbb út a telefonszámos ellenőrzés: SMS-enként fizetős, és
  több személyes adatot kezel (GDPR).
- A belépéshez kell egy adatvédelmi tájékoztató, a fiók törlésének lehetősége, és EU-régió
  (Firestore: `eur3`, Cloud Run: `europe-west1`).
- Új domain esetén a Mapbox-token URL-korlátozását a Mapbox-fiókban bővíteni kell (ez a te lépésed).
