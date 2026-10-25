# VDR-0037 — Pont de llums per mòduls amb modes, sirenes espanyoles i intermitents sota control del jugador

- **Data:** 2026-10-25
- **Estat:** Acceptada (complementa VDR-0031 i VDR-0034)

## Context

El propietari volia una sirena "molt més realista tipus simulador": modes de llum que recreïn els dels Mossos i les
policies locals, un pont que no siguin "dos blocs", diverses sirenes de les que es fan servir a Espanya i un botó per
activar-les, desactivar-les i alternar-les; intermitents a tots els cotxes; i la part del darrere dels Mossos
rotulada com la real. Fins ara el pont era una llum per meitat que o estava apagada o feia el seu únic patró, i una
sola sirena lligada a l'estat del pont.

## Decisió

- **Pont per mòduls i modes** (`js/actor-models.js createLightbarMaterial`): la barra es llegeix com 8 mòduls amb
  junta; l'atribut per instància `barLit` és el **mode**: 0 apagat, 1 *posició* (tot fix i atenuat), 2 *prioritari*
  (meitats alternes amb doble flaix), 3 *emergència* (parells exteriors/interiors en ràfegues triples més un escombrat).
  El cotxe del jugador porta dues llums puntuals blaves que segueixen la cadència (`controllers.js updateCarLights`);
  el trànsit en emergència usa el mode 3. Només blau (Espanya).
- **Sirenes** (`js/audio-synthesis.js SIREN_KINDS`): bitonal, wail, yelp (3,2 Hz) i phaser (9 Hz) sobre el mateix
  circuit d'escombrat; `audio-sources.js` porta `sirenKind` per font i `audio-system.js` refà la veu quan canvia.
- **Control independent**: `L` recorre els modes de llum, `K` les sirenes (amb `off`), cap no implica l'altre; només
  en cotxes amb pont (Policia Municipal, Mossos). Segona línia del quadre amb l'estat.
- **Intermitents** a tots els cotxes del jugador: `Q` esquerre, `E` dret, `X` emergència (`setTurnSignal`), amb
  autocancel·lació després d'uns 50° de gir amb el volant recte; pinta `carState.y/z`, que el material ja feia servir
  per al trànsit.
- **Llibrea**: "policia" del capó llegit des de davant (fotos), i la cua dels Mossos (banda blau marí amb
  "www.mossos.cat", escacs vermells i blancs a baix) a partir de dues fotos més de Wikimedia Commons (VDR-0035).

- **Correcció del mateix dia** (setena ronda): el mode emergència parpellejava a 31 Hz (invisible); els patrons
  passen a temps que l'ull resol (prioritari 1 Hz amb doble flaix de 90 ms; emergència 1,25 Hz amb ràfegues triples
  de 60/60 ms) i es comparteixen entre el shader i les llums puntuals (`LIGHTBAR_PATTERN`), amb un test de durades
  (`tests/lightbar.test.cjs`). Les sirenes es retoquen cap a greu, lent i amb glissando; sense gravació de referència
  continuen sent aproximades (🟠). La Policia Municipal es repinta amb la imatge corporativa dels Ford Kuga de 2024
  (foto de La Ciutat); la cua s'extrapola dels costats fins a tenir-ne foto (🟠).

- **Vuitena ronda**: l'escombrat se superposava a les ràfegues a un altre ritme i el patró es perdia; passa a ser el
  **mode 4 (escombrat)**, i l'emergència queda neta. Cinc modes a `L`.

## Alternatives considerades

- **Un sol botó que engegui llums i sirena alhora**: més simple, però el propietari vol decidir què es veu i què se
  sent; a la realitat també són comandaments separats.
- **Patrons al CPU per instància**: descartat, el shader els fa amb `time` i l'índex de mòdul sense cost per cotxe.
- **Mostres d'àudio reals**: no n'hi ha de lliures identificades; els tons són síntesi aproximada (🟡).

## Conseqüències

- Pendent ⚪: que el trànsit s'aparti del jugador amb sirena; llums de calandra i retrovisor; "air horn"; rotulat de
  les llunes dels Mossos (són part WINDOW del loft); gravacions per afinar cadències.
- Proves: `tests/controllers.test.cjs` (intermitents, modes i sirenes). Captures: capó, cua, modes 2 i 3.

*Un polsim de Viandox:* el cuiner tria el foc i la sal per separat; una sola maneta per a tot crema el sofregit.
