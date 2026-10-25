# VDR-0030 — Col·lisió amb el mobiliari urbà i els arbres a partir de les matrius d'instància, no dels punts de col·locació

- **Data:** 2026-10-25
- **Estat:** Acceptada

## Context

El jugador travessava fanals, pals de semàfor, pilones, papereres, bancs i troncs d'arbre: només es provava
`allColliders` (edificis, monuments, parapets de la riera). Els `footprints` de `js/street-details.js` i
`js/city-grid.js` eren caixes alineades als eixos pensades només per a la IA del tràfic, i no totes les crides de
col·locació en registraven un (`NEXT_STEPS.md` §2.1.1 proposava afegir `kind`/`radius` a cada `addFootprint`).

## Decisió

**Llegir les matrius d'instància acabades, una vegada, al final de la construcció**, en lloc de registrar cada prop al
lloc on es col·loca:

- Al **final de `buildStreetDetails()`** el mòdul recorre `M.column`, `M.post`, `M.signalPole`, `M.pedPole`,
  `M.plaquePole`, `M.bollard` i `M.bin` (x = `elements[12]`, z = `elements[14]`) i totes les entrades de
  `treePositions` (radi del tronc = `TREE_SPECIES[species].trunk.r × scale` + 4 cm), i exporta **`obstacles`** com a
  cilindres `{x, z, r, h, kind}`.
- **`buildCityGrid()`** fa el mateix amb els fanals i arbres de parc, i exporta els **bancs com a caixes orientades**
  (`propBoxes`) en el format dels col·lisionadors d'edificis (`{minX..maxZ, minY, maxY, obb:{cx,cz,hx,hz,cs,sn}}`).
- `main.js` passa els cilindres a `controllerManager.setPropColliders()` (cel·les de 48 m) i afegeix les caixes dels
  bancs a la llista de col·lisionadors.
- `controllers.js` resol **cotxe (rectangle orientat) contra cilindre** i **persona / ciclista (cercle) contra
  cilindre**: empenta de sortida, impuls segons la velocitat d'aproximació, cop de guinyada al voltant del contacte,
  sacsejada de la suspensió, espurnes i `reportCollision(..., 'prop', ...)` cap a l'àudio. Les papereres cedeixen (0,45
  de l'impuls); pals, pilones i troncs no. Els teleports i `isClearAt()` els respecten.

Tot darrere de **`FEATURES.propCollisions`**.

## Alternatives considerades

- **`kind`/`radius` a cada crida d'`addFootprint`** (el que deia `NEXT_STEPS.md`): descartat; hi ha una desena de punts
  de crida, alguns props no en tenien cap i un prop futur es tornaria a oblidar. Llegir les matrius al final no pot
  deixar-se cap instància.
- **Ficar tots els props a la llista d'OBB dels edificis**: adoptat **només per als bancs** (són caixes); els cilindres
  necessiten el seu propi contacte, més barat i més just per a un pal.

## Conseqüències

- Proves a `tests/controllers.test.cjs`: un pal atura el cotxe, paperera contra pilona, els vianants rellisquen al
  voltant dels troncs, els teleports els eviten.
- Depèn del fet que les matrius d'instància siguin l'estat final: qualsevol prop que es mogui després (ara cap) hauria
  d'actualitzar `obstacles`.
- **No fet**: props trencables (pilones o papereres que cauen). Els props **no tenen comprovació d'alçada** respecte dels
  taulers de pont (VDR-0023): un prop sota un pont podria aturar un cotxe al tauler de sobre; és rar i queda anotat.

*Un polsim de Viandox:* es compta el que hi ha a la taula quan ja és parada, no el que cadascú diu que hi ha portat.
