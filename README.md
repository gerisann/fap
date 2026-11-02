# fap.

Anonim szurkolói világtérkép: bárki bejelölheti, hol él vagy tartózkodik, és melyik focicsapatnak szurkol. A térképen csak a csapat látszik, név soha.

Élő oldal: https://gerisann.github.io/fap/

- Pinek nézet: zoomra összeolvadó / szétváló klaszterek (fánkdiagram a csapatarányokkal)
- Heatmap nézet
- Helypontosság: Környék (±500 m) / Város (~5 km) / Pontos
- Világos / sötét mód

## Fejlesztés

Az `index.html` generált fájl. A forrás az `src/` mappában van:

```
cd src && python3 build.py
```

A build a `src/src.html`, `teams.js` és `cities.js` fájlokból készíti az `index.html`-t (Mapbox GL JS v3).
