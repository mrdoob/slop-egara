# VDR-0034 — Les emergències policials no arrenquen soles: només les engega l'usuari

- **Data:** 2026-10-25
- **Estat:** Acceptada (modifica VDR-0031)

## Context

VDR-0031 va introduir els estats de la policia del trànsit (`js/traffic.js`): patrulla per defecte i, cada 2,5–5
minuts, una **emergència aleatòria** d'una patrulla a 60–450 m de la càmera (pont de llums, sirena, prioritat als
semàfors). A la primera prova amb el servidor local el propietari ho va rebutjar: no havia demanat que la policia
encengués els llums pel seu compte; amb que l'usuari pugui encendre'ls n'hi ha prou.

## Decisió

- `updateEmergencies(dt)` només **apaga** les emergències en curs quan se'ls acaba el temporitzador (o el cotxe surt
  del graf); cap rellotge aleatori les engega.
- `startEmergency()` (exposat a `trafficSystem` i, per tant, a `window.__slop.traffic`) envia la patrulla més propera
  a la càmera (60–450 m, al graf, no en emergència) a una emergència de 40–90 s. És l'única manera d'encendre-les al
  trànsit: la consola o una prova.
- El cotxe policial del jugador conserva la seva tecla `L` (pont + sirena, `controllerManager.setLightbar`).
- `FEATURES.emergencyStates` continua governant tot el bloc (desactivat, es torna al comportament original: tota la
  policia amb sirena).

## Alternatives considerades

- **Un commutador més** (`randomEmergencies`) deixant el rellotge al codi: descartat, és codi mort que convida a
  reactivar-lo sense demanar-ho.
- **Emergències lligades a esdeveniments del joc** (una col·lisió forta del jugador, un atropellament): plausible per a
  un mode joc futur, però és una decisió nova que caldria demanar.

## Conseqüències

- `HOW_TO_IMPROVE.md` §3 (sessió 4, punts 5 i 8) i §5.1 ho recullen; `NEXT_STEPS.md` §2.5 també.
- Les proves de trànsit no depenen del rellotge (ja comprovaven `priority` directament).
- Si un dia es vol un trànsit amb emergències, cal una decisió explícita del propietari (i probablement un botó a la
  interfície, no un dau).

*Un polsim de Viandox:* el foc l'encén qui cuina, no la cuina sola.
