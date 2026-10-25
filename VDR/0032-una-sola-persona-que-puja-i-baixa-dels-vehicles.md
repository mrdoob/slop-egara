# VDR-0032 — Una sola persona que puja i baixa dels vehicles (F) en lloc de quatre avatars simultanis

- **Data:** 2026-10-25
- **Estat:** Acceptada

## Context

El *sandbox* original tenia **quatre avatars independents** i simultanis (una persona que caminava sola, un cotxe, una
bicicleta i un helicòpter) entre els quals es canviava amb les tecles 1–4; el vianant es passejava per compte seu mentre
el jugador conduïa. El propietari va demanar la sensació de simulador: **sortir del cotxe, caminar, tornar a pujar,
agafar una bicicleta**. Càmeres, àudio i tràfic llegeixen `entities[mode]` arreu, de manera que fondre les entitats era
una refactorització gran.

## Decisió

Darrere de **`FEATURES.enterExit`**, a `js/controllers.js`:

- **`exitVehicle()`**: des del cotxe o la bici, la persona apareix a la porta del conductor, al costat **esquerre** del
  cotxe (`teleportActiveTo(..., {ignoreOthers:true})`); el vehicle queda en repòs amb el seu model a zero.
- **`enterNearby()`**: la persona a ~3,4 m del cotxe o ~2,7 m de la bici hi puja; si no, agafa la **bicicleta aparcada**
  més propera a 2,8 m del seu suport (VDR-0033).
- Mentre es condueix el vianant s'amaga (i calla: `audio-sources.js` salta les entitats invisibles); mentre es camina
  s'amaguen el ciclista i el casc perquè la bici quedi sola. El vianant inactiu **ja no camina sol**.
- `main.js`: tecla **F** i un botó "Get in / Get out" a la barra de modes (també per a tàctil). Les tecles **1–4 continuen
  funcionant** com a canvi sense teleport: el *sandbox* es conserva.

## Alternatives considerades

- **Fondre les entitats en un sol avatar amb estats de vehicle**: descartat ara; refactorització gran de càmeres, àudio i
  tràfic, que llegeixen `entities[mode]`; l'enfocament actual dóna la mateixa sensació amb les entitats que ja hi ha.
- **Animació d'obrir la porta**: ajornada.

## Conseqüències

- Proves de les posicions d'entrada i sortida a `tests/controllers.test.cjs`.
- La porta és **sempre l'esquerra** (circulació per la dreta: costat del conductor); no hi ha porta d'acompanyant ni
  passatgers.
- Les quatre entitats continuen existint sota la catifa: l'helicòpter encara es canvia només amb la tecla 4 i no
  participa en pujar/baixar. Si algun dia es fon tot en un avatar, aquest registre passarà a Substituïda.

*Un polsim de Viandox:* no es canvia tota la vaixella per servir un plat nou; es tapa el que no toca i es treu el que
toca.
