# Grand Theft Ègara

> *Terrassa a escala 1:1, amb relleu i tot. Sí, Terrassa. No, Sabadell no hi surt (a la llunyania, de bajísimo detalle, com toca).*

Això és **Frankfurt City** amb motor WebGPU: la ciutat amb més bars de frankfurts per càpita del món conegut, la Manchester catalana, la capital de l'hoquei, l'únic lloc del planeta on el Viandox és un condiment de taula i no una pregunta, el lloc on la Rambla és d'Ègara i no de Barcelona. Un simulador de Terrassa fet amb [three.js](https://threejs.org/), WebGPURenderer i TSL, on pots voltar a peu, en taxi blanc, en bici o en helicòpter de rescat per **tots els carrers de debò**, al seu lloc de debò, amb el seu nom de debò i sense abreviar res: *Carrer de Sant Pere*, *Rambla d'Ègara*, *Plaça Vella*, *Passeig del Comte d'Ègara*. Si hi busques "C/ Sant Pere" no el trobaràs. Això és una ciutat seriosa.

Vine a:

- sortir del taxi a la **Plaça Vella** i mirar amunt cap al campanar de la **Catedral del Sant Esperit**;
- baixar la **Rambla d'Ègara** fins al **mNACTEC** (el Vapor Aymerich, Amat i Jover, amb les seves dents de serra) i tornar a pujar perquè t'has passat de llarg, com tothom; i ara *baixar* vol dir baixar, que la Rambla té pendent de debò;
- perdre't pel **Parc de Vallparadís**, que és un torrent de veritat amb els seus deu metres de fondària i els seus ponts, i trobar-te el **Castell Cartoixa** i la **Seu d'Ègara** com qui no vol la cosa;
- fer-te la foto davant la **Masia Freixa** del Parc de Sant Jordi (aquí no hi ha casaments, però les cúpules hi són);
- comprar al **Mercat de la Independència**, agafar Rodalies a l'**Estació del Nord** i acabar a l'**Estadi Olímpic** mirant hoquei;
- comptar xemeneies: la de la **Bòbila Almirall** fa 63 metres i és la més alta de Catalunya, i al simulador també;
- travessar la **Riera de les Arenes** per un pont, com Déu mana, i no pel mig, que està canalitzada i fa 28 metres;
- pujar a **Can Tusell** o a **Torre-sana** amb el taxi i notar que la ciutat fa pujada (la Plaça Vella és a 279 m; el nord del terme passa dels 500);
- enfilar-te amb l'helicòpter i veure **la Mola** i el **Montcau** al nord. Sabadell queda a l'est. Prou.

Encara no es pot demanar un frankfurt amb Viandox. Els 547 bars i botigues amb nom hi són, amb el seu rètol a la paret que toca; la salsa, de moment, l'has de portar de casa.

## D'on surt tot això

És un fork de [mrdoob/slop-newyork](https://github.com/mrdoob/slop-newyork) ("Slop New York", una simulació de Manhattan) amb tota la ciutat canviada per Terrassa. Manhattan és una quadrícula; Terrassa és un nucli medieval, un Eixample girat 13,7° respecte del nord, barris dels anys setanta i un munt de polígons. Per això la ciutat sencera corre pel sistema de **graf de carrers** que l'original només feia servir a Lower Manhattan: no hi ha avingudes numerades ni Central Park ni costa, hi ha 2.320 illes de cases reals, 4.687 carrers reals, 236 cruïlles amb semàfor reals, tots els edificis amb la planta i les plantes del Cadastre, i el relleu del model d'elevacions de l'ICGC, amb els ponts com a ponts i no com a terraplens.

La geografia ve d'**OpenStreetMap** (carrers, parcs, rieres, comerços), els edificis del **Cadastre** (INSPIRE) i el relleu de l'**ICGC** (model d'elevacions de 5 m). El que és exacte, el que és aproximat, el que és directament inventat (hi ha coses inventades, no som màgics: els arbres de carrer, les faroles i els pilons, per exemple) i **com millorar cada capa** està documentat fil per randa, en castellà, a [HOW_TO_IMPROVE.md](HOW_TO_IMPROVE.md). El **per què** de cada decisió és a [VDR/](VDR/README.md), uns ADR amb un polsim de Viandox, com toca. I el que falta, per ordre, a [NEXT_STEPS.md](NEXT_STEPS.md).

## Engega-ho

És una web estàtica (mòduls ES, three.js des de jsDelivr). Serveix l'arrel del repositori amb qualsevol servidor estàtic i obre-ho amb un navegador amb WebGPU (Chrome, Edge; Safari 26 o Firefox amb WebGPU activat; si no, cau a WebGL2):

```bash
npx serve .
# o bé
python3 -m http.server 8000
```

Tecles: `1`–`4` mode de desplaçament, `W A S D` moure's (al cotxe: `W` accelera, `S` frena i, aturat, marxa enrere), `Shift` fre de mà al cotxe i esprint a peu o en bici, `Q` `E` intermitents i `X` emergència, `F` pujar i baixar del cotxe o la bici (o agafar una bici aparcada), `G` canviar de cotxe, `L` els cinc modes del pont de llums i `K` les sirenes del cotxe policial, `B` botzina, `V` canviar de càmera, `M` el plànol sencer de la ciutat (clica on vulguis per teletransportar-t'hi), `H` vista neta, `N` silenci.

## Tests

```bash
node --test 'tests/**/*.test.*'
```

Són suites `node:test` sense dependències: càmeres, plànol, controls, trànsit, destins de teletransport (cada arribada cau en un carrer real dins la ciutat), el lector de GeoTIFF i el relleu, i la llista de precàrrega de mòduls de `index.html`. Hi ha també una prova de fum sense extensions, `node tools/browser-smoke.mjs`, que engega un Chrome sense finestra, espera que la ciutat estigui construïda, fa captures i mesura (per exemple, quants edificis queden enterrats: la resposta correcta és cap).

## Construir les dades

`js/terrassa-geodata.js` es genera des d'OpenStreetMap amb `tools/build-geodata.mjs`. Els extractes font són a `tools/data/terrassa/` (baixats amb `tools/overpass.sh` i les consultes Overpass de `tools/data/q_*.overpassql`). Per refrescar-los i reconstruir (la baixada necessita xarxa i pega a l'API pública d'Overpass: sigues amable):

```bash
for q in boundary roads landmarks landuse region buildings; do
  bash tools/overpass.sh tools/data/terrassa/osm_$q.json tools/data/q_$q.overpassql 6
done
GEO_DATA=tools/data/terrassa node --max-old-space-size=8192 tools/build-geodata.mjs
```

La pipeline mesura ella mateixa el marc (origen al centre de la Plaça Vella, eixos girats 13,7° a l'oest del nord seguint la trama de l'Eixample), simplifica la geometria, dedueix amples de calçada, solars i usos del sòl, i escriu un sol mòdul. Els edificis del Cadastre s'extreuen amb `tools/catastro-to-json.py` (HOW_TO_IMPROVE.md §2.5).

El relleu, `js/terrassa-terrain.bin`, surt del model d'elevacions de 5 m de l'ICGC (servei WCS) amb `tools/geo-terrain.mjs`, que a més l'acondiciona per a una ciutat: hi escriu els carrers amb el seu perfil, deixa els ponts com a taulers, estén cada illa des de la seva vorada i es queixa, en xifres, de tot el que encara fa pujada on no toca (HOW_TO_IMPROVE.md §2.8):

```bash
# el model ja és al repositori, comprimit (tools/data/dem/*.asc.gz); per tornar-lo a baixar de l'ICGC:
# curl "https://geoserveis.icgc.cat/icc_mdt/wcs/service?SERVICE=WCS&VERSION=1.0.0&REQUEST=GetCoverage&COVERAGE=icc:met&CRS=EPSG:25831&RESPONSE_CRS=EPSG:25831&BBOX=412010,4596910,423260,4608770&WIDTH=2250&HEIGHT=2372&FORMAT=ARCGRID" | gzip -9 > tools/data/dem/icgc_met5_terrassa_epsg25831.asc.gz
node tools/geo-terrain.mjs --epsg 25831 --smooth 5 tools/data/dem/icgc_met5_terrassa_epsg25831.asc.gz
```

A HOW_TO_IMPROVE.md §2 hi ha què conté cada extracte, els forats coneguts i les fonts millors per tapar-los.

## Fes-te'l teu

Forca'l, remena'l, millora'l, trenca'l. Fes-ne jocs, animacions, pel·lícules, experiments o una cosa completament diferent. Afegeix-hi el teu barri si el veus massa buit. Posa-hi els frankfurts. Posa-hi el Viandox. Diverteix-te.

## Llicència i dades

El codi és sota [llicència MIT](LICENSE), com l'original [Slop New York](https://github.com/mrdoob/slop-newyork) de mrdoob i col·laboradors, del qual deriva aquest projecte.

Dades geogràfiques © [col·laboradors d'OpenStreetMap](https://www.openstreetmap.org/copyright), disponibles sota l'[Open Database License](https://opendatacommons.org/licenses/odbl/) (ODbL). Edificis: [Dirección General del Catastro](https://www.catastro.hacienda.gob.es/) (serveis INSPIRE). Relleu: [Institut Cartogràfic i Geològic de Catalunya](https://www.icgc.cat/), Model d'Elevacions del Terreny 5 × 5 m, [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Les dades i dependències de tercers conserven les seves llicències.
