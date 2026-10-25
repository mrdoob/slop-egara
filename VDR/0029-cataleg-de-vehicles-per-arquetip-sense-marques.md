# VDR-0029 — Catàleg de vehicles per arquetip, sense marques (`VEHICLE_CATALOGUE`)

- **Data:** 2026-10-25
- **Estat:** Acceptada

## Context

Amb el model per roda (VDR-0028) cada cotxe ja podia tenir massa, parell, adherència i suspensió pròpies, però el
jugador només tenia un cotxe. El propietari va demanar poder **triar entre cotxes amb acceleració, direcció i potència
diferents**, i que **la policia i els taxis fossin molt plausibles**. No hi ha geometria amb llicència (els *lofts* de
`js/actor-models.js` són genèrics) i el repositori no fa peticions de xarxa sense permís (VDR-0010), de manera que no
es poden carregar models externs.

## Decisió

Un **`VEHICLE_CATALOGUE`** a `js/vehicle-physics.js` amb sis entrades, totes **arquetips sense cap marca ni model
real**, amb xifres dins del rang de la seva classe ("inspirat en", no una reproducció):

| id | Què és | Notes |
|---|---|---|
| taxi | Berlina híbrida blanca, franja vermella i blava de porta de Terrassa, rètol al sostre | 90 kW, 1480 kg |
| compacte | Compacte | 110 kW, 1320 kg |
| SUV familiar | SUV de tracció total | 1620 kg, centre de gravetat més alt |
| Policia Municipal de Terrassa | Berlina, lliurea 1 | vegeu VDR-0031 |
| Mossos d'Esquadra | SUV, lliurea 2 | vegeu VDR-0031 |
| Esportiu | Compacte esportiu, 221 kW, tracció total | sense TCS |

Cada `spec` porta **identitat** (*loft* de carrosseria `BODY_SPECS` 'sedan' / 'suv' / 'taxi' d'`actor-models.js`,
lliurea = `carState.w`, pintura) i **dinàmica** (massa, `cgHeight`, inèrcia de guinyada, parell, règim màxim, marxes,
grup final, tracció, `cdA`, μ, rigidesa de deriva, força i repartiment de frens, abs/tcs, suspensió k/c/recorregut/
antibalanceig, angle i ritme de direcció, `topSpeedKmh`).

A `controllers.js`, `applyVehicle()` reconstrueix el cotxe del jugador des d'una `spec` (carrosseria, decals, matrícules,
llums, rodes, pont de llums) i `setVehicle(id)` el canvia al lloc. El garatge és a `main.js` / `index.html`
(`#vehicle-picker`; la tecla **G** va passant; la tria es desa a `localStorage` `terrassa-player-state`, camp `vehicle`).
Les mides de col·lisió del cotxe (`halfW`, `halfL`) surten de la `spec`, i `traffic.js` les llegeix de l'entitat en
lloc del 0,86 × 2,18 fix d'abans. Tot darrere de **`FEATURES.vehicleGarage`**.

## Alternatives considerades

- **Models reals amb nom** (SEAT León, Toyota Prius…): descartat; marques registrades i cap geometria amb llicència; els
  *lofts* són genèrics i posar-hi un nom seria fals.
- **Un sol cotxe amb controls lliscants**: descartat; menys llegible i sense lliurees, que és el que fa plausibles taxi i
  policia.
- **Carregar models GLB**: descartat; no hi ha actius al repositori i no es fa xarxa.

## Conseqüències

- Afegir un vehicle és afegir **un objecte al catàleg**; el HUD escala la velocitat amb `topSpeedKmh` del vehicle.
- Les lliurees són **aproximacions de memòria** (sense referència fotogràfica; VDR-0031 i `HOW_TO_IMPROVE.md` §5.1).
- Les xifres de cada arquetip no s'han contrastat amb fitxes tècniques concretes: són ordres de magnitud de la classe.

*Un polsim de Viandox:* a la carta hi posem "guisat de la casa", no el nom del ramader; el gust és el que compta.
