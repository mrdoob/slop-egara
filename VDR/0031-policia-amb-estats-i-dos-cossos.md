# VDR-0031 — Policia amb estats (patrulla / emergència) i dos cossos: Policia Municipal i Mossos d'Esquadra

- **Data:** 2026-10-25
- **Estat:** Acceptada (les emergències aleatòries, substituïdes per VDR-0034: només les engega l'usuari)

## Context

Un cotxe de cada 60 del tràfic era de policia, **sempre** amb sirena i pont de llums encès, i només de Policia
Municipal. El propietari va demanar que **per defecte no sonés cap sirena** i que hi hagués **cotxes dels Mossos
d'Esquadra**, que a Terrassa patrullen al costat de la Municipal. La sirena i les sis regles de prioritat del tràfic
(`js/traffic.js`) llegien `v.isPolice`.

## Decisió

A `js/traffic.js` cada cotxe de policia porta **`corps`** (1 Policia Municipal, berlina; 2 Mossos d'Esquadra, carrosseria
SUV; alternats), **`emergency`**, **`siren`**, **`priority`** i **`emergencyTimer`**:

- **Estat per defecte, patrulla**: pont apagat, sense sirena, obeeix els semàfors com qualsevol cotxe (les sis regles
  de prioritat que llegien `v.isPolice` ara llegeixen `v.priority`).
- **`updateEmergencies()`**: cada 2,5–5 min un cotxe de patrulla en ruta a 60–450 m de la càmera comença un servei de
  40–90 s (pont encès, sirena, prioritat de pas). **`startEmergency()`** queda exposada per a proves i consola.
- **Ponts de llums**: atribut per instància **`barLit`** (`createLightbarMaterial` d'`actor-models.js` el llegeix;
  `createLightbarMesh(spec, count)`), una malla instanciada per carrosseria; els punts de llum blaus només durant un
  servei.
- **Lliurees** (`carState.w`): 1 = banda de quadres de la Municipal (existent); 2 = Mossos (blanc, banda ampla blau fosc
  sobre les portes amb una línia vermella a la vora superior i traços blancs de lletres), pintades a
  `createLoftedCarMaterial`.
- **Àudio** (`audio-sources.js`): la sirena sona des de `v.siren`; la del cotxe de patrulla del jugador, des d'
  `entity.sirenOn` (tecla **L**, via `controllerManager.setLightbar`).

Tot darrere de **`FEATURES.emergencyStates`**; apagat, el comportament original (tota la policia encesa i amb sirena,
només Municipal).

## Alternatives considerades

- **Treure les sirenes del tot**: descartat; les emergències existeixen i l'àudio és bo; el problema era la freqüència.
- **Un tercer cos (Guàrdia Urbana)**: no existeix a Terrassa.
- **Ambulàncies del SEM i Bombers**: ajornat; el mateix mecanisme d'estats els serviria.

## Conseqüències

- Les dues lliurees són **aproximacions de memòria**, sense referència fotogràfica; `HOW_TO_IMPROVE.md` §5.1 les marca
  🟠. Els colors i proporcions reals de la banda dels Mossos i dels quadres de la Municipal no s'han verificat.
- El tràfic **encara no s'aparta** davant d'un vehicle en emergència; el cotxe de patrulla del jugador **no rep
  prioritat** de la IA encara que porti el pont encès.
- La cadència 2,5–5 min i la finestra 60–450 m són valors triats a ull perquè es vegi un servei de tant en tant sense
  convertir la ciutat en una persecució.

*Un polsim de Viandox:* el pebre vermell hi va, però al final i de mica en mica; si l'hi tires tot d'entrada no es
menja res més.
