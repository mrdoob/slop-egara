# VDR — Viandox Decision Records

Un **VDR** és un *Architecture Decision Record* (ADR) amb un polsim de **Viandox**, que és el que a Terrassa es posa
a tot. Fora del terme municipal ningú no sap què és; aquí és un costum "molt arrelat" segons
[Canal Terrassa](https://x.com/CanalTerrassa/status/1920851340260962720), surt a la llista viral de
[com som la gent de Terrassa](https://monterrassa.cat/societat/com-som-gent-terrassa-tiktoker-viral-explicant-409323/)
al costat de l'hoquei i la Mola, és casella de *starter pack* al
[Diari de Terrassa](https://www.diarideterrassa.com/terrassa/2024/08/10/no-ets-terrassenc-si-a-lestiu-no-has-fet-mai/),
dóna nom a un grup de motoristes, a una proposta d'arquitectura per a la seu del COAC i fins i tot l'Òscar Andreu
el va triar com a símbol del que uneix tots els terrassencs. Si el `README.md` del repositori ja és *Frankfurt City*,
el registre de decisions havia de ser això: la salsa que distingeix un egarenc a cent metres.

Fora de la broma, un VDR és el registre clàssic d'una decisió d'arquitectura (context → decisió → alternatives →
conseqüències), escrit **en català**, factual i amb cites als fitxers del repositori, que acaba amb una frase curta de
regust culinari. Com el Viandox: una mica dóna gust, massa ho tapa tot; la frase final no és mai una excusa per no dir
les coses.

Els VDR responen "**per què** es va fer així i què es va descartar". El **què** i el **com** de cada capa (fidelitat,
dades, millores) continuen a [`HOW_TO_IMPROVE.md`](../HOW_TO_IMPROVE.md) i el **què falta** a
[`NEXT_STEPS.md`](../NEXT_STEPS.md).

## Quan s'escriu un VDR

Sempre que es prengui una decisió **significativa** en treballar al repositori: d'arquitectura (quin mòdul mana sobre
què), de font de dades (OSM, Catastro, ICGC…), de format (com es guarda una dada), de compromís (rendiment vs
fidelitat, exactitud vs esforç) o d'abast (què s'ataca primer, què es deixa). Una decisió que es revisa no s'esborra:
el registre vell passa a **Substituïda** i enllaça el nou.

## Numeració i nom de fitxer

`VDR/NNNN-slug.md`: quatre dígits seqüencials (el següent és el més alt de l'índex + 1; mai es reutilitza un número) i
un *slug* curt en català, en minúscules i amb guions. S'afegeix una fila a l'índex d'aquest README.

## Estats

| Estat | Significat |
|---|---|
| **Proposada** | Decisió plantejada, encara no en vigor (p. ex. pendent d'un permís o d'una dada) |
| **Acceptada** | En vigor. Pot portar un matís entre parèntesis ("en curs", "implementació pendent de verificar") |
| **Substituïda** | Reemplaçada per un VDR posterior, que s'ha de citar |

## Plantilla

```markdown
# VDR-NNNN — Títol en una frase (la decisió, no el tema)

- **Data:** AAAA-MM-DD
- **Estat:** Acceptada | Proposada | Substituïda (per VDR-MMMM)

## Context

Quin problema hi havia, quines restriccions (dades, llicències, rendiment, permisos) i què deia el repositori abans.
Cita fitxers (`tools/…`, `js/…`) i seccions (`HOW_TO_IMPROVE.md` §x.y).

## Decisió

Què s'ha decidit, en present, amb el detall just perquè algú ho pugui comprovar al codi.

## Alternatives considerades

- Alternativa i per què es descarta (o es deixa per a més endavant, amb l'enllaç a `NEXT_STEPS.md`).

## Conseqüències

Què guanyem, què perdem, què queda pendent. Si alguna part no s'ha pogut verificar al codi, dir-ho aquí.

*Un polsim de Viandox:* una sola frase, lleugera, de cuina; que no tapi res del que hi ha a sobre.
```

## Índex

| Núm. | Títol | Data | Estat |
|---|---|---|---|
| [0001](0001-motor-de-graf-per-a-tota-la-ciutat.md) | El motor de graf de carrers mou tota la ciutat (adéu a la retícula de Manhattan) | 2026-10-24 | Acceptada |
| [0002](0002-marc-del-mon-placa-vella.md) | Marc del món: 1 m per unitat, origen a la Plaça Vella, eixos girats −13,7° | 2026-10-24 | Acceptada |
| [0003](0003-openstreetmap-primera-font.md) | OpenStreetMap com a primera font de dades (descarregat amb permís explícit) | 2026-10-24 | Acceptada |
| [0004](0004-catastro-font-principal-edificis.md) | El Catastro INSPIRE és la font principal d'edificis; OSM només omple forats | 2026-10-24 | Acceptada |
| [0005](0005-geodata-generat-unica-dada-del-runtime.md) | `js/terrassa-geodata.js` generat és l'única dada que llegeix el runtime | 2026-10-24 | Acceptada |
| [0006](0006-illes-per-rasteritzacio-de-calcades.md) | Les illes surten d'un ràster de les calçades, no d'OSM | 2026-10-24 | Acceptada |
| [0007](0007-barris-per-voronoi-de-nodes-osm.md) | Barris assignats per Voronoi dels nodes `place=neighbourhood` d'OSM | 2026-10-24 | Acceptada |
| [0008](0008-retols-de-comerc-a-la-paret-real-mes-propera.md) | Els rètols dels comerços es pengen a la paret real més propera, i només a parets reals | 2026-10-24 | Acceptada |
| [0009](0009-documentar-tot-a-how-to-improve.md) | Documentació exhaustiva a `HOW_TO_IMPROVE.md` després de cada pas | 2026-10-24 | Acceptada |
| [0010](0010-cap-peticio-de-xarxa-sense-permis.md) | Cap petició de xarxa sense permís explícit del propietari | 2026-10-24 | Acceptada |
| [0011](0011-cada-millora-darrere-d-un-interruptor-i-en-commit-aillat.md) | Cada millora darrere d'un interruptor i en un commit aïllat; dades abans que codi | 2026-10-24 | Acceptada |
| [0012](0012-comencar-pel-relleu-real-branca-terrain.md) | Començar el full de ruta pel relleu real, en una branca `terrain` i darrere de `FEATURES.terrain` | 2026-10-25 | Acceptada (fusionada a `main`) |
| [0013](0013-relleu-en-binari-separat-terrassa-terrain-bin.md) | El relleu viatja en un binari a part (`js/terrassa-terrain.bin`, format `TRN1`), relatiu a la Plaça Vella | 2026-10-25 | Substituïda (per VDR-0021) |
| [0014](0014-lector-geotiff-i-utm-propis-sense-gdal.md) | Lector GeoTIFF / Arc-Info ASCII i projector UTM propis en Node, sense GDAL; el marc es llegeix de `GEO.frame` | 2026-10-25 | Acceptada |
| [0015](0015-geo-terrain-fonts-per-preferencia-i-mode-sintetic.md) | `geo-terrain.mjs`: diversos ràsters per preferència, forats omplerts, i un mode `--synthetic` només per a desenvolupament | 2026-10-25 | Acceptada |
| [0016](0016-un-sol-punt-de-veritat-per-a-l-alcada-ciutat-plana-elevada.md) | Un sol punt de veritat per a l'alçada (`terrainY` → `groundHeightAt`); la ciutat es genera plana i després s'eleva | 2026-10-25 | Acceptada (implementada) |
| [0017](0017-files-de-finestres-des-de-la-base-de-la-caixa.md) | Les files de finestres de la façana es calculen des de la base de la pròpia caixa, no des de `y` del món | 2026-10-25 | Acceptada (implementada; monuments pendents) |
| [0018](0018-descarrega-del-mde-de-l-icgc.md) | Descarregar el model d'elevacions de l'ICGC (MET 5 m pel WCS) per al relleu real, i versionar el `.bin` generat | 2026-10-25 | Acceptada (descarregat el 2026-10-25) |
| [0019](0019-adoptar-els-viandox-decision-records.md) | Adoptar els Viandox Decision Records (VDR) per a les decisions significatives | 2026-10-25 | Acceptada |
| [0020](0020-geometria-del-terra-tallada-sobre-la-reticula-del-relleu.md) | La geometria del terra es talla sobre la pròpia retícula del relleu, no per bisecció d'arestes | 2026-10-25 | Acceptada |
| [0021](0021-cella-de-10-m-i-tauler-sobre-la-reticula-de-les-dades.md) | Cel·les de relleu de 10 m, i el tauler d'asfalt dibuixat exactament sobre aquesta retícula | 2026-10-25 | Acceptada |
| [0022](0022-el-relleu-es-condiciona-per-a-una-ciutat-abans-de-servir-lo.md) | El relleu es condiciona per a una ciutat a l'eina abans de servir-lo, i es verifica amb un informe procedimental | 2026-10-25 | Acceptada (en curs) |
| [0023](0023-els-ponts-son-taulers-no-terraplens.md) | Els ponts són taulers sobre el relleu, no terraplens: taula `BRDG` al fitxer i nivell triat per proximitat (`hint`) | 2026-10-25 | Acceptada |
| [0024](0024-assentament-dels-edificis-per-volum-a-la-cota-de-la-facana.md) | Cada volum d'edifici s'assenta a la cota més alta de les seves façanes al carrer, amb sòcol cec i façanes llargues esglaonades | 2026-10-25 | Acceptada |
| [0025](0025-totes-les-alcades-es-mesuren-sobre-el-terra-mai-en-y-absoluta.md) | Totes les alçades es mesuren sobre el terra (`groundHeightAt` / `terrainY`), mai com a `y` absoluta | 2026-10-25 | Acceptada |
| [0026](0026-prova-de-fum-headless-amb-chrome-pel-protocol-devtools.md) | Prova de fum *headless* pròpia (`tools/browser-smoke.mjs`): Chrome pel protocol DevTools, sense dependències, amb `window.__slop` | 2026-10-25 | Acceptada |
| [0027](0027-elevar-al-relleu-exactament-una-vegada.md) | Tot el que s'escriu a cota de vorada s'eleva al relleu exactament una vegada | 2026-10-25 | Acceptada |
| [0028](0028-model-de-conduccio-propi-per-roda.md) | Model de conducció propi per roda (`js/vehicle-physics.js`), quatre suspensions independents i sense motor de físiques extern | 2026-10-25 | Acceptada |
| [0029](0029-cataleg-de-vehicles-per-arquetip-sense-marques.md) | Catàleg de vehicles per arquetip, sense marques (`VEHICLE_CATALOGUE`), amb garatge darrere de `FEATURES.vehicleGarage` | 2026-10-25 | Acceptada |
| [0030](0030-collisio-amb-mobiliari-des-de-les-matrius-d-instancia.md) | Col·lisió amb el mobiliari urbà i els arbres a partir de les matrius d'instància, no dels punts de col·locació | 2026-10-25 | Acceptada |
| [0031](0031-policia-amb-estats-i-dos-cossos.md) | Policia amb estats (patrulla / emergència) i dos cossos: Policia Municipal i Mossos d'Esquadra | 2026-10-25 | Acceptada |
| [0032](0032-una-sola-persona-que-puja-i-baixa-dels-vehicles.md) | Una sola persona que puja i baixa dels vehicles (F) en lloc de quatre avatars simultanis | 2026-10-25 | Acceptada |
| [0033](0033-bicicletes-aparcades-procedurals.md) | Bicicletes aparcades procedurals a suports d'U invertida (`js/parked-bikes.js`), fins que arribin les dades d'OSM | 2026-10-25 | Acceptada |
| [0034](0034-les-emergencies-policials-nomes-les-engega-l-usuari.md) | Les emergències policials no arrenquen soles: només les engega l'usuari (`startEmergency()`); modifica VDR-0031 | 2026-10-25 | Acceptada |
| [0035](0035-llibrees-a-partir-de-fotografies-mai-de-memoria.md) | Les llibrees dels vehicles es pinten a partir de fotografies, mai de memòria (regla; taxi, Policia Municipal i Mossos repintats) | 2026-10-25 | Acceptada |
| [0036](0036-aproximacions-i-pilas-dels-ponts-al-runtime.md) | Les aproximacions, els murs i les piles dels ponts es completen al runtime (`addRamps`, `buildBridgeGeometry`), no a la dada | 2026-10-25 | Acceptada |
| [0037](0037-pont-de-llums-per-moduls-sirenes-i-intermitents-sota-control-del-jugador.md) | Pont de llums per mòduls amb modes, sirenes espanyoles i intermitents sota control del jugador (L, K, Q/E/X) | 2026-10-25 | Acceptada |
