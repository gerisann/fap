# Tribe-ok – közösségi funkció terve

## Alapötlet

A **Tribe** egy csapat és egy város párosa, például „Arsenal · Budapest”. Ha a környékeden még nincs
tribe-ja a csapatodnak, létrehozod; mások csatlakozhatnak hozzá, a helyiek és az odautazók is.
A tribe-on belül hírfolyam van: kérdések, meccsnézések, kocsmaajánlók.

> Példa: Londonban vagy, Arsenal-meccset néznél → a térképen rábökök az „Arsenal · London” tribe-ra →
> csatlakozom → megkérdezem, melyik a jó Arsenal-kocsma, vagy rámegyek egy már kiírt meccsnézésre.

> Döntések (2026-11-03): **hírfolyam először**, a chat a T3-ban jön. Tribe-ot **az hozhat létre,
> akinek van pinje**, a saját csapatára, bármely városban; csatlakozni bárki bárhová tud. Az ütemtervbe
> mind a négy extra bekerül (élő meccstérkép, utazó mód, meccsnaptár + derbi, jelvények + klubok).
> **Csatlakozni és létrehozni csak a közelben lehet:** ~50 km-en belül a pinedtől, vagy egy friss
> (72 órás) „Itt vagyok most” jelzéstől (böngészős helymeghatározás, 0,05°-ra kerekítve, csak a
> tulajdonos olvashatja: `presence/{uid}`). Olvasni bárki olvashat. A helymeghatározás meghamisítható,
> ez tehát a véletlen és a lusta visszaéléseket szűri ki.

## Alapelvek (az anonimitás itt is első)

- **Becenév, nem valódi név.** Az első csatlakozáskor becenevet választasz; a Google-neved és az
  e-mail-címed soha nem látszik.
- **A tribe helye a város középpontja**, nem a tagoké. A tribe-ból nem derül ki, ki hol lakik.
- **Moderálás az első naptól:** jelentés gomb, automatikus elrejtés N jelentés után, kapitányi
  moderálás, rate limit. Az EU DSA szerint ez „notice and action” kötelezettség, és kell hozzá
  kapcsolattartási pont is.
- Korhatár: **16+** (GDPR, Magyarország).

## Meccsnap – „Szurkolok!” (következő lépés)

Mért és eldöntött (2026-11-03):
- **Forrás: API-Football, ingyenes csomag.** A `GET /fixtures?date=YYYY-MM-DD` **egy hívással az adott nap
  összes meccsét** adja, lapozás nélkül: élesben mérve kedden 221 meccs / 71 bajnokság / 41 ország,
  szerdán 246 / 93 / 63, `paging.total = 1`, kb. 200 KB. Az NB II, a Championship és a Serie D is benne van.
- **Korlát:** az ingyenes csomag csak a tegnap–ma–holnap dátumokat engedi, és napi 100 kérést ad. Nekünk
  napi 2 kérés kell (ma + holnap).
- **Szurkolni a meccs napján egész nap lehet, a meccs végéig** (nem csak a meccs ideje alatt).
- A gólhullám későbbre halasztva.
- Az API-kulcs nem kerülhet a kliensbe. Egy ütemezett szerveroldali job kéri le az adatot, és
  statikus JSON-t tesz ki. A tervezett megoldás GitHub Actions, ami ingyenes és nem kell hozzá
  Google-számlázás. A kulcsot a felhasználó GitHub-secretként adja meg.
- Nyitott kérdés: a +25 XP-t a szabályok csak akkor tudják ellenőrizni, ha a meccsadat a Firestore-ban
  is megvan (ehhez a jobnak szolgáltatásfiók kell). Enélkül a jóváírás napi egyszeri limittel működik.
- A csapatnevek eltérnek (pl. „Ferencvarosi TC” ↔ „Ferencváros”), ezért névegyeztetés és kézi
  alias-tábla kell.

## Funkciók

| Elem | Leírás |
|---|---|
| Tribe-réteg a térképen | Csapatszínű jelvény a városban, a taglétszámmal; kattintásra megnyílik a tribe-panel. |
| Létrehozás | Belépett felhasználó, a saját csapatára, egy városra (Photon-kereső / a saját pinje városa). Csapatonként és városonként egy tribe (azonosító: `csapat + város OSM-id`). |
| Csatlakozás / kilépés | Bárki, bármelyik tribe-hoz (az utazókat is ez szolgálja). Egy felhasználó több tribe-nak is tagja lehet. |
| Szerepek | A létrehozó a **kapitány**, és társkapitányokat nevezhet ki. Ők rejthetnek el posztot, és tilthatnak ki tagot. |
| Hírfolyam | Szöveges posztok + válaszok, reakciók (⚽ 🔥 👏). |
| Meccsnézés-esemény | Poszttípus: meccs, időpont, hely (Photon-kereső), „Jövök” visszajelzés, létszám. |
| Helyajánló | Poszttípus: kocsma vagy hely, címmel; a tagok felszavazhatják → „a tribe kedvenc helyei” lista. |
| Meghívó link | `tribemap.web.app/t/<id>` + QR-kód, WhatsAppra küldhető. |

## Adatmodell (Firestore)

```
users/{uid}                         nick, createdAt                    (csak a tulajdonos olvassa)
tribes/{tribeId}                    team, city, cityOsm, country, lat, lng (városközép),
                                    memberCount, postCount, createdAt, lastActivityAt
tribes/{id}/members/{uid}           nick, role (captain|cocaptain|member), joinedAt
tribes/{id}/posts/{postId}          authorUid, nick, type (text|event|place), text,
                                    event{title, startsAt, placeName, lat, lng}, place{name, address},
                                    replyCount, reactions{⚽:n…}, goingCount, reportCount, hidden, createdAt
tribes/{id}/posts/{pid}/replies/{rid}
tribes/{id}/posts/{pid}/rsvps/{uid}
reports/{reportId}                  csak írható; moderációs sorba megy
```

- A számlálókat (`memberCount`, `goingCount`) a szabályok `getAfter()`/`existsAfter()`-rel ellenőrzik
  (pontosan ±1, ugyanabban a batch-ben). Szerver nélkül is megbízhatók.
- Rate limit a szabályokban: posztonként `lastPostAt` a tagdokumentumban, minimum 20 mp.
- **Olvasási költség:** a hírfolyam lapozva (20 poszt), csak a megnyitott tribe-é. A tribe-réteg a
  térképen egyetlen gyűjtemény-lekérdezés; nagy forgalomnál ezt is a Cloud Run-os gyorsítótár viszi.

## Ütemezés

| Fázis | Tartalom | Számlázás kell? |
|---|---|---|
| T1 | Becenév, tribe létrehozása / csatlakozás / kilépés, tribe-réteg, tribe-panel, szöveges hírfolyam + válaszok, jelentés, kapitányi elrejtés, szabályok, ÁSZF + adatvédelmi kiegészítés | nem |
| T2 | Meccsnézés-esemény + „Jövök”, helyajánló + felszavazás, meghívó link / QR, reakciók | nem |
| T3 | Automatikus moderálás (Gemini / Perspective), push értesítések (FCM), meccsnaptár-API, valós idejű chat | **igen** (Cloud Run / Functions) |
| T4 | Meccsnapi élő térkép, jelvények, ranglisták, megosztható kártyák | részben |

## További ötletek

1. **Meccsnapi élő térkép + rangadó-mérő.** Amíg a csapatod játszik, belépve a „Szurkolok!” gombbal
   felvillansz a térképen a csapatod színében (városszinten, a meccs végéig). Élő statisztika: hányan
   szurkolnak éppen a világon, és hol (ország / város toplista), **szemben a rivális csapattal**
   (osztott sáv, ki „nyeri” a lelátót régiónként). Gólnál gólhullám fut végig a térképen.
   Kell hozzá meccsnaptár (ki kivel, mikor) és szerveroldali összesítés (Cloud Run: percenkénti
   CDN-cache-elt összesítő), különben minden néző minden jelzést olvasna → T3/T4, számlázás kell.
2. **Utazó szurkoló mód.** „3 napig Lisszabonban vagyok”: ideiglenes, lejáró jelenlét. A helyi tribe
   jelzést kap, hogy egy vendégszurkoló van a városban.
3. **Idegenbeli meccs.** A rendező város tribe-ja fogadja az odautazókat (találkozópont, kocsma, jegyinfo).
4. **Meccsnaptár.** Minden tribe látja a csapata következő meccseit (pl. football-data.org), egy
   kattintással meccsnézés-esemény lesz belőle.
5. **Városi derbik.** „Ki uralja Budapestet?”: heti tribe-ranglista tagok, események és aktivitás alapján.
6. **Jelvények.** Alapító, első a városban, 10 meccsnézés, öt ország tribe-jainak tagja („Világutazó”).
7. **Hitelesített szurkolói klubok.** Valódi szurkolói klub igényelheti a tribe-ot → „hitelesített”
   jelvény. Később partneri lehetőség.
8. **Megosztható tribe-kártya** (OG-kép): „Arsenal · Budapest – 42 tag, következő meccsnézés: szombat 18:30”.
