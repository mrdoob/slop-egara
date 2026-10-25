# VDR-0036 — Les aproximacions, els murs i les piles dels ponts es completen al runtime, no a la dada

- **Data:** 2026-10-25
- **Estat:** Acceptada (complementa VDR-0023: els ponts són taulers, no terraplens)

## Context

El propietari va trobar "horribles" els ponts de les autopistes i de la Mútua: color gairebé blanc, taulers que no
connectaven amb el carrer, lloses que es creuaven en l'aire. Mesurat amb Node sobre la taula de ponts del fitxer de
relleu (`tests`-style, `terrain.js` + `terrassa-terrain.bin`): dels 280 extrems de tauler, **81 quedaven a més de
0,3 m del terreny al seu nus**, alguns a 5–12 m. Dues causes: (1) nusos de viaducte partits en diversos trams
`bridge` (el nus és enlaire i el tauler continua: correcte), i (2) estribs sobre la rasa que l'eina va excavar per al
carrer que passa per sota (`clearUnderBridges`, perfil del carrer inferior), amb el terreny que torna a pujar fins a
la cota del tauler 20–40 m més enllà, o estribs de ramal d'enllaç que l'eina no va alçar. Refer les cotes a
`tools/geo-terrain.mjs` implicava regenerar el `.bin` i tornar a validar tot el relleu (VDR-0022).

## Decisió

- **`js/terrain.js`**: el tauler té alçades per vèrtex (`b.ys`, `deckY` lineal a trossos) en comptes de dues cotes.
  **`fitAbutments()`**: tot extrem en un nus que també porta carrers (un estrib) es posa **a la cota del carrer**
  (`terrainY` al nus) si la taula no se n'allunya més de 2,5 m: 100 dels 254 estribs ho necessitaven (el Pont del
  Passeig era 1,4 m per sobre del Passeig). És la regla principal: un pont acaba on acaba el carrer, mai més enllà.
  Només després, `addRamps()` prolonga cada extrem sense continuació (cap altre tauler al nus a menys de 0,8 m) que pengi més de
  0,5 m sobre el terreny: **en horitzontal** fins on el sòl torna a pujar a la cota del tauler (màx. 90 m: l'estrib
  real és més enllà de la rasa), o si no en **rampa del 9 %** fins a tocar el sòl (màx. 120 m). 13 prolongacions
  (els 14 estribs amb 2,6–7,4 m de desnivell, tots a enllaços d'autopista). La primera versió, sense `fitAbutments`,
  va allargar els pretils del Pont del Passeig 36 m carrer endins buscant el sòl a la cota de la taula: el propietari
  ho va veure i va fixar el criteri.
  `b.cls` (autopista = vorals en lloc de voreres), `b.ramp0/ramp1`. Els cotxes i vianants ho segueixen perquè
  `groundHeightAt → bridgeAt → deckY` ja llegeixen la taula.
- **`js/city-grid.js buildBridgeGeometry`**: on el tauler va a menys de 3 m del sòl, els costats baixen com a **murs
  de contenció** (terraplè); on va alt, llosa de 0,9 m i **piles** rectangulars cada 22 m (mai a les rampes ni a 5 m
  dels extrems, mai si queden a menys d'1,2 m del sòl); un **mur d'estrib** tanca l'extrem que encara pengi; formigó
  0x7e7b76 i pretils 0x8c8983 (abans 0x9c9990, blanc al sol).
- **A l'eina, finalment** (tercera i quarta ronda del propietari, el mateix dia), `tools/geo-terrain.mjs`:
  `nodeHeights` dona a un estrib amb calçades la cota de les seves calçades elevada al sòl més alt dels carrers a 45 m
  però **mai per sobre de l'altre extrem del tauler** (el tauler surt pla i el tram curt hi puja); després del tallat,
  `stampAbutments` **segella** una altiplà de 10 m (+10 m de barreja) a la cota del nus, perquè la barreja de perfils
  dels encreuaments (`carveRoads`) no hi arrossegui una rampa veïna (la sortida de l'aparcament del costat del Pont
  del Passeig l'enfonsava 1,1 m); `clearUnderBridges` ja no toca la cel·la de 10 m del nus (`end` 12); i `bridgeDecks`
  llegeix la cota **final** de la malla a l'estrib. Resultat: 0 de 254 estribs desviats > 0,3 m. El `.bin` es regenera
  amb el MDT arxivat; `fitAbutments` queda com a xarxa de seguretat del runtime.
- `buildBridgeGeometry` remostreja el tauler cada 4 m: els laterals baixen com a murs que segueixen el terreny on la
  llosa va a menys de 3 m del sòl, un **front d'estrib** tanca el pas de tram en terra a va, i els dos extrems porten
  tapes: la llosa fins a la calçada (una tapa fins al pretil era un mur travessant la carretera: quarta ronda), i els
  testers de les voreres i dels pretils. `quad()` comprova el sentit de gir amb el producte vectorial: la calçada
  estava enrotllada al revés i, amb el material d'asfalt d'una sola cara, era invisible (es veia la llosa de formigó:
  "el color de l'asfalt és diferent"). Cap tauler ensenya la llosa buida.
- **Cinquena ronda** (forats laterals, gira pels altres ponts, crestes): el segell de l'estrib passa a ser un
  rectangle de l'amplada del tauler (+3 m, de 8 m carrer endins a 12 m sota el tauler; només el creuament en si es
  força sobre altres calçades, perquè un pas inferior a 13 m, l'Avinguda de Joaquim de Sagrera, no s'hissi); els
  extrems de tauler a < 12 m (calçades bessones) s'uneixen a una cota (`joinDeckEnds`, també després de
  `raiseBridgeAbutments`, amb el màxim) i el segell els tracta com a grup; `buildBridgeGeometry` suprimeix vorera,
  pretil i col·lisionador al costat on `bridgeAt` troba un tauler veí (els dos taulers d'una autovia de doble calçada
  llegeixen com un pont amb mitjana: abans el pretil interior de l'un era dins dels carrils de l'altre, el cotxe
  s'hi aturava a 33 km/h); i el pretil del canal d'una riera deixa forat sota els taulers (Pont de les Arts). Residu
  conegut: a la Ctra. de Terrassa sobre l'Av. del Vallès els dos taulers bessons queden 1,2 m desfasats (el pas
  inferior és a 8 m de l'estrib: la malla de 10 m no pot tenir-hi les dues cotes).
- **Mètode de prova**: cada pont es comprova **circulant-hi amb el cotxe en els dos sentits** amb captures cada 2 s i
  un ganxo `setCollisionListener` que registra què toca, a peu als testers i a migdia per al color; mai només amb
  captures estàtiques des de fora. Una auditoria Node sobre la taula de ponts (muesques laterals, graons d'accés,
  crestes) tria on anar.
- Verificació visual amb la prova de fum headless (VDR-0026, ara amb `--shot` i `__slop.bridges`).

## Alternatives considerades

- **Arreglar les cotes a l'eina** i regenerar el relleu: primer es va descartar per no tocar el perfil dels carrers
  veïns; a la tercera ronda es va fer igualment (vegeu Decisió), perquè el runtime no pot inventar on acaba un
  carrer. Els ramals del nus C-58/B-40 (trams de 15 m amb 3–4 m de desnivell) continuen pendents a l'eina.
- **Terraplens en comptes de taulers**: descartat a VDR-0023.
- **Models per pont** (arcs del Pont del Passeig): pendent, amb fotos (NEXT_STEPS.md §1.1).

## Conseqüències

- Els ponts llegeixen com a infraestructura: piles, murs, arribada al carrer. Les prolongacions són geometria i dada
  del runtime: si l'eina millora les cotes, `addRamps` deixarà de disparar-se sola.
- ⚪ El nus C-58/B-40 continua lleig (dada). ⚪ Sense arcs, sense baranes metàl·liques, sense juntes de dilatació.
- `HOW_TO_IMPROVE.md` §3 (sessió 4, punt 9) i la taula de §1.3 ho recullen.

*Un polsim de Viandox:* si el pont no arriba a la riba, s'allarga la passarel·la; no es mou el riu.
