# VDR-0033 — Bicicletes aparcades procedurals a suports d'U invertida (`js/parked-bikes.js`)

- **Data:** 2026-10-25
- **Estat:** Acceptada

## Context

Perquè pujar i baixar de vehicles (VDR-0032) tingués sentit calia **bicicletes aparcades per agafar**. Les dades
baixades no contenen cap inventari d'aparcaments de bicicleta de Terrassa: no hi ha `amenity=bicycle_parking` a la
geodata (no es va descarregar; fer-ho demana permís, VDR-0010). Qualsevol col·locació és, doncs, procedimental i s'ha de
marcar com a tal.

## Decisió

Un mòdul nou **`buildParkedBikes(scene, {isClear, groundAt})`** a `js/parked-bikes.js`:

- **Llavors**: al voltant de les places (`SQUARES`), dels punts de teleport dels monuments i estacions
  (`TELEPORT_LOCATIONS`) i d'un de cada quatre bars (`SHOPS` de `kind` 1).
- **Candidats** en anells de 3–14 m, acceptats només sobre **illes de vorera** (`blockAt`: ni espai obert ni mitjana) i
  lliures d'edificis i props (`controllerManager.isClearAt`, VDR-0030).
- El suport s'alinea amb el **carrer més proper** (`nearestRoads`); dues bicicletes per suport, travesseres, amb el
  morro cap enfora de la calçada.
- **Geometria**: un `InstancedMesh` d'una bicicleta fusionada en un sol material, amb les mides de la del jugador (rodes
  de 0,35 m a 1,16 m de distància) i colors per instància; suports d'U invertida com a `TubeGeometry`.
- **`take(x, z, r)`** anul·la la instància i retorna la seva posa (la fa servir `enterNearby()`); **`restore(index)`**
  existeix però no s'usa. Límit: **600 bicicletes**.

Marcat com a procedimental (🟠) a `HOW_TO_IMPROVE.md`.

## Alternatives considerades

- **Descarregar `amenity=bicycle_parking` d'OSM**: és la font correcta, però vol permís de xarxa (VDR-0010); es
  proposarà. El mòdul podria llavors llegir una llista de la geodata en lloc de sembrar.
- **Bicicletes al llarg de totes les vorades**: descartat; massa, i no és així a Terrassa.

## Conseqüències

- Una bicicleta agafada **no torna mai al seu suport** (la del jugador queda on la deixa); `restore` hi és per quan
  calgui.
- Els suports poden caure en **places privades** que són illes de vorera, perquè el criteri és geomètric, no de
  propietat.
- Ni la quantitat ni la posició dels suports corresponen a res real: quan arribin les dades d'OSM, aquesta decisió
  s'hauria de substituir.

*Un polsim de Viandox:* mentre no arriba el pa de la fleca, se'n posa del d'ahir a la cistella perquè la taula no quedi
buida.
