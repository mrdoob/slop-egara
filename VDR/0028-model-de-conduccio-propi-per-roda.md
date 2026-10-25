# VDR-0028 — Model de conducció propi per roda (`js/vehicle-physics.js`), sense motor de físiques extern

- **Data:** 2026-10-25
- **Estat:** Acceptada

## Context

El cotxe del jugador era *arcade*: una velocitat escalar al llarg del rumb (`CAR_DRIVE`, `driveSpeed()` a
`js/controllers.js`) i una molla de 3 graus de llibertat sobre el xassís només per a l'aspecte. No hi havia
transferència de càrrega, ni gravetat pel pendent, ni rodes que patinessin o es bloquegessin, i el relleu real de
Terrassa (VDR-0016, VDR-0018) no afectava la conducció. El propietari va demanar una sensació de simulador i,
explícitament, que **cada roda tingués la seva pròpia suspensió**, com als simuladors. La regla del repositori
prohibeix afegir dependències (`CLAUDE.md`), i tota millora ha d'anar darrere d'un commutador (VDR-0011).

## Decisió

Un mòdul nou **`js/vehicle-physics.js` d'aritmètica pura** (sense three.js), amb `createVehicleState(spec, {wheelbase,
track})` i `stepVehicle(state, input, dt, env)`, sub-integrat a **240 Hz**:

- **Cos rígid al pla** (x, z, rumb; vx, vz, velocitat de guinyada) i **quatre molla-amortidors independents**
  (deflexió de cada roda respecte de l'alçada estàtica, barra antibalanceig per eix, càrrega de cada roda derivada de la
  seva molla, de manera que la transferència de càrrega *emergeix*). El cos fa *heave*, capcineig i balanceig sobre el
  pla del terra ajustat pels quatre punts de contacte (`groundPlane`); cada roda llegeix la seva pròpia alçada
  (`groundAt`, el relleu real).
- **Pneumàtics** amb angle de deriva i força lateral de Pacejka ("fórmula màgica") amb pic μ×càrrega, cercle de fricció
  (una roda que patina o es bloqueja perd adherència lateral), ABS/TCS per vehicle i fre de mà que bloqueja l'eix
  posterior.
- **Tren motriu**: corba de parell (`torqueFraction`), canvi automàtic (relacions, grup final, lògica de canvi amb tall
  de parell), fre motor, repartiment fwd/rwd/awd; resistència aerodinàmica, de rodolament i **gravetat al llarg i a
  través del pendent** sota el cotxe.
- **Direcció** sensible a la velocitat i limitada en ritme. Convencions de signe a la capçalera del fitxer: +x local
  és l'**esquerra** del cotxe (com l'intermitent "left (+x)" del tràfic); guinyada i balanceig segueixen `rotation.y` i
  `rotation.z` de three.js; capcineig positiu = morro amunt.

Integració a `controllers.js` (`updateCarPhysics()`): entrades W (accelerador), S (fre i, aturat, marxa enrere), A/D,
Shift (fre de mà); cada fotograma incorpora al model els cops externs (col·lisions d'aquest gestor i del tràfic, que
escriuen `speed`, `vx/vz`, `angularVel`, `pitchVel`… a l'entitat) i torna a escriure `speed` (endavant) i `vx/vz`
(residu de deriva) perquè càmera, HUD, àudio i tràfic continuïn llegint els mateixos camps. La malla arrel segueix el
pla del terra (`rotation.x = -slopePitch`, `rotation.z = slopeRoll`), el pivot del xassís va sobre les molles i cada
roda sobre el seu terra (`bump`). Tot darrere de **`FEATURES.carPhysics`** (`js/city-config.js`); apagat, el camí
*arcade* de `controllers.js` queda intacte.

## Alternatives considerades

- **Un motor de físiques real** (cannon-es, Rapier, ammo): descartat; la regla de no afegir dependències ho impedeix i
  un motor 3D complet és excessiu per a un cotxe sobre un camp d'alçades.
- **Mantenir el model *arcade* i afinar constants**: descartat; no pot fer transferència de càrrega, gravetat pel
  pendent ni bloqueig de rodes.
- **Model de bicicleta (una sola via)**: descartat; el propietari va demanar quatre rodes amb molla pròpia i la
  resposta a vorades i sots per costat.

## Conseqüències

- `tests/vehicle-physics.test.cjs`: 14 proves numèriques (0–100 km/h per vehicle, frenada 50→0 en 8,7–10,7 m amb
  capcineig, ~0,7 g en corba amb el cos inclinat cap enfora, rotació amb fre de mà, marxa enrere, aguantar al ralentí en
  un 8 % i recular en un 20 %, vorada sota un sol costat, estabilitat amb un fotograma llarg).
- L'*arcade* `CAR_DRIVE` queda com a recanvi; cap altre vehicle (bici, helicòpter, tràfic) fa servir el model.
- **Pendent**: àudio del motor a partir de les rpm (`audio-sources.js` encara deriva la càrrega de les tecles); marques
  de pneumàtic i so de derrapada des de `state.skid`; adherència per superfície segons `surface` d'OSM (el ganxo
  `env.grip` existeix però no s'usa). Les xifres són plausibles per classe, no mesurades en cap cotxe real.

*Un polsim de Viandox:* la salsa es fa amb el que hi ha a l'armari; no cal comprar-ne cap de pot si saps lligar-la.
