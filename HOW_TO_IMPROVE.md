# Slop Terrassa — Diario de desarrollo y guía de mejora

Este documento es el registro completo de cómo se ha adaptado *Slop New York* (simulación 1:1 de Manhattan de
mrdoob) a **Slop Terrassa**, qué partes de la ciudad son exactas, cuáles son aproximaciones, cuáles son invenciones
plausibles, y **cómo completar o mejorar cada una**. Se actualiza en cada sesión de trabajo. Fecha de inicio:
2026-10-24.

Convención del registro de fidelidad:

| Marca | Significado |
|---|---|
| ✅ **Exacto** | Geometría o dato real tomado tal cual de la fuente (OpenStreetMap, Catastro, ICGC) a escala 1:1 |
| 🟡 **Derivado** | Calculado a partir de datos reales con un modelo o heurística (p. ej. ancho de calzada a partir de la clase de vía) |
| 🟠 **Aproximado** | Dato real incompleto completado con valores típicos del barrio o la tipología |
| 🔴 **Inventado** | No hay dato: se genera de forma procedural plausible (igual que hacía el original con los edificios de Manhattan) |
| ⚪ **Pendiente** | Todavía no implementado en esta versión |

---

## 1. Decisiones de arquitectura

### 1.1 Por qué Terrassa no puede usar el motor "de retícula" del original

El original construye Manhattan con dos sistemas:

1. **Retícula** (calles numeradas por su `z`, avenidas por su `x`, Central Park, costa de la isla): ~60 % del código
   de `city-grid.js`, `street-details.js`, `buildings.js` y toda la configuración de `city-config.js`.
2. **Grafo de calles** (`GEO.roadGraph`, `js/road-network.js` paso 4b): el sistema que usaba para Lower Manhattan,
   Broadway y las calles curvas del norte, donde no hay retícula.

Terrassa es una ciudad interior, sin costa, sin isla, con un casco antiguo irregular, un Eixample en retícula girada
13,7° al oeste del norte y barrios periféricos con trazados propios. **Toda la ciudad corre por el sistema de grafo.**
Las tablas de calles/avenidas quedan vacías y los módulos que dependían de ellas se han generalizado (ver §4).

### 1.2 Marco de coordenadas (`tools/geo-base.mjs`)

| Elemento | Valor | Fidelidad |
|---|---|---|
| Origen (0, 0) | Centro de la **Plaça Vella** (way OSM 27491525): lat 41.561974, lon 2.011102 | ✅ |
| Orientación de los ejes | Histograma de orientación (mod 90°) ponderado por longitud de las calles a <1,5 km del origen: pico en **−13,70°** (el "norte" de la retícula del Eixample está 13,7° al oeste del norte real). `x` = este de retícula, `z` = sur de retícula | 🟡 medido sobre datos reales |
| Escala | 1 unidad = 1 m, proyección plano tangente local (misma fórmula que el original) | ✅ |
| Caja de detalle | lat 41.538–41.608, lon 1.972–2.052 (≈ 6,6 × 7,8 km): el área urbana completa, de Les Fonts/Can Parellada al sur a Can Tusell/Pla del Bon Aire al norte | — |

**Cómo mejorarlo:** si en el futuro se prefiere alinear los ejes con la Rambla d'Ègara y el casco antiguo (que van
casi norte-sur, pico secundario a 2°), basta cambiar el radio de 1500 m a 600 m en la calibración de `geo-base.mjs`.
La elección actual favorece al Eixample porque es donde hay más manzanas rectangulares, y las manzanas que no están
alineadas reciben su propio marco de fachada (frontage frames), igual que Lower Manhattan en el original.

### 1.3 Fuentes de datos: OpenStreetMap, Catastro e ICGC

NYC tenía datos municipales abiertos (DCP, CSCL, NYC Parks). Para Terrassa la base es **OpenStreetMap** (ODbL:
calles, usos del suelo, parques, rieras, comercios, monumentos), descargado con `tools/overpass.sh` y las consultas
`tools/data/q_*.overpassql` (2026-10-24, con permiso explícito del propietario; los JSON están en
`tools/data/terrassa/`). Desde la sesión 2 los **edificios** vienen del Catastro INSPIRE (§2.5) y desde la sesión 3 el
**relieve** del modelo de elevaciones de 5 m del ICGC (§2.8, archivado comprimido en `tools/data/dem/`). Cada
descarga se ha hecho con autorización expresa.

| Fichero | Contenido | Tamaño | Notas de cobertura |
|---|---|---|---|
| `osm_boundary.json` | 31 términos municipales (admin_level 8) del entorno | 0,8 MB | Terrassa: 70,3 km², 897 vértices tras simplificar a 4 m |
| `osm_roads.json` | 12.914 vías `highway=*` del área urbana + 4.730 nodos (semáforos, pasos, stop) | 11,6 MB | 6.536 vías con nombre; `lanes` en 2.296; `width` solo en 120; `oneway` en 3.628 |
| `osm_buildings.json` | 13.504 huellas de edificio + 230 relaciones | 11 MB | **Solo 390 con `building:levels`, 16 con `height`.** La importación del Catastro no cubrió Terrassa: la cobertura es parcial e irregular por barrios |
| `osm_landuse.json` | 1.936 polígonos de uso del suelo, 834 árboles, 211 tramos de rieras/torrents, 44 tramos de vía férrea | 5,6 MB | 93 parques, 84 jardines, 15 plazas con nombre |
| `osm_landmarks.json` | 457 elementos con nombre; 51 nodos de barrio (`place=neighbourhood`), 17 plazas | 0,6 MB | 340 monumentos/edificios singulares tras filtrar estatuas y placas |
| `osm_region.json` | Autopistas, carreteras, ferrocarriles, polígonos de asentamiento, 20 poblaciones y 220 cimas a <16 km | 7,4 MB | Para el horizonte de bajo detalle |
| `osm_shops.json` | 868 comercios y servicios (766 con nombre): restaurantes, supermercados, farmacias, bancos, peluquerías… | 0,3 MB | Rótulos reales. La cobertura de OSM es parcial (Terrassa tiene miles de comercios) |
| `catastro.json` (de `tools/data/catastro/`, Catastro INSPIRE *Buildings* 08279) | **25.880 edificios y 101.848 partes** con plantas sobre rasante, uso (residencial 22.808, industrial 1.654, comercial 553, equipamientos 385, oficinas 173, agrario 209), año de construcción y nº de viviendas | 23 MB (GML original 380 MB) | Descargado el 2026-10-24 con permiso. Licencia: reutilización libre con atribución a la Dirección General del Catastro. Conversión UTM 31N → WGS84 en `tools/catastro-to-json.py` (error comprobado contra OSM: 0,1–5,7 m en los centroides de 5 monumentos) |

**Cómo mejorar los datos:**

- **Edificios (prioridad máxima):** la cobertura real está en el Catastro (Dirección General del Catastro, licencia
  compatible con atribución) y en el **ICGC** (Institut Cartogràfic i Geològic de Catalunya: *Base topogràfica 1:5.000*
  y *Edificacions 3D / LiDAR*, licencia CC BY 4.0). Ambos dan huella + plantas/altura de **todos** los edificios.
  Descargar el GML de Catastro del municipio 08279 (servicio INSPIRE *Buildings*) y convertirlo al mismo esquema
  que `osm_buildings.json` (ver §2.5) multiplicaría por ~4 el número de huellas y daría alturas reales en todas.
- **Alturas de edificios:** el modelo LiDAR del ICGC (MDS 2 m) permite calcular la altura de cada huella. Alternativa
  rápida: completar `building:levels` en OSM para las manzanas céntricas (y volver a descargar).
- **Anchos de calzada:** el ICGC *Base topogràfica 1:5.000* incluye las aceras y bordillos reales (polígonos de
  calzada), que sustituirían el modelo heurístico de anchos (§2.2).
- **Barrios:** el Ajuntament de Terrassa publica los límites oficiales de los 45 barris y 6 districtes en su portal
  de datos abiertos (`opendata.terrassa.cat`); sustituirían la asignación por nodo más cercano (§2.6).
- **Relieve:** ✅ hecho con el MDE de 5 m del ICGC (§2.8). Queda el modelo LiDAR de 2 m (solo por WMS o descarga
  interactiva) y los pasos superiores sin etiqueta `bridge` en OSM.

Para volver a descargar (requiere red; peticiones a `overpass-api.de`):

```bash
for q in boundary roads landmarks landuse region buildings; do
  bash tools/overpass.sh tools/data/terrassa/osm_$q.json tools/data/q_$q.overpassql 6
done
GEO_DATA=tools/data/terrassa node --max-old-space-size=8192 tools/build-geodata.mjs
```

Catastro (los GML originales, 380 MB, **no están en el repositorio**; sí el `catastro.json` convertido). Para
regenerarlo: descargar `https://www.catastro.hacienda.gob.es/INSPIRE/Buildings/08/08279-TERRASSA/A.ES.SDGC.BU.08279.zip`
(el servidor falla con `curl` por la cadena de certificados en macOS; `python3 -c "import urllib.request..."` funciona),
descomprimirlo en `tools/data/catastro/` y ejecutar:

```bash
python3 -I tools/catastro-to-json.py tools/data/catastro tools/data/terrassa/catastro.json
```

---

## 2. Pipeline de datos (`tools/`)

### 2.1 Límites y suelo (`geo-base.mjs`)

- ✅ Límite municipal de Terrassa y de los 30 municipios vecinos (para el mapa y el horizonte).
- 🟡 "Suelo" de la simulación = la caja de detalle (rectángulo girado en el marco del mundo). No hay agua: la calzada
  de asfalto que el original extendía por toda la isla se extiende aquí por toda la caja, y las manzanas se recortan
  encima. Las zonas no urbanas (bosque, campos) son manzanas con clase de uso del suelo (§2.4) y se pintan como tales.

### 2.2 Calles (`geo-roads.mjs`)

| Dato | Fidelidad | Detalle |
|---|---|---|
| Trazado de cada calle (eje) | ✅ | Geometría OSM, simplificada a 0,4–0,6 m |
| Nombre | ✅ | `name` de OSM en catalán completo, sin abreviar ("Carrer de Sant Pere", "Rambla d'Ègara"). Las vías sin nombre quedan con nombre vacío (1 de cada 4 tramos: pasajes, viales de polígono, enlaces) |
| Sentido único | ✅ | `oneway`, `junction=roundabout` |
| Número de carriles | 🟠 | `lanes` cuando existe (2.296 vías); si no, por clase: 1 en residencial de sentido único, 2 en el resto |
| **Ancho de calzada** (bordillo a bordillo) | 🟡 | `width` si existe (120 vías). Si no: `carriles × ancho de carril + aparcamiento típico`: residencial sentido único ≈ 5,9 m (mediana resultante), residencial doble sentido ≥ 7,5 m, terciaria ≈ 9,5 m, secundaria ≈ 9,2 m, peatonal 4 m. Tabla `LANE`/`EXTRA` en `geo-roads.mjs` |
| Ancho de acera | 🟠 | Constante `SIDEWALK = 2.4 m` (ver `geo-blocks.mjs`); en el Eixample real varía entre 1,5 y 3 m, en avenidas más |
| Túneles | — | Excluidos (no se dibujan ni se circula): p. ej. la C-58 soterrada, los pasos inferiores |
| Puentes y viaductos | 🟡 | Los 140 tramos `bridge=yes` son **tableros** a la cota de sus estribos sobre el relieve (§2.8, §5.7), con aceras (arcenes en autopista) y pretiles; desde la sesión 4: **pilas** cada 22 m bajo los vanos altos, **muros de contención** en los tramos bajos y en las rampas, extremos prolongados hasta el suelo (`VDR-0036`), hormigón gris mate. Sin arcos ni la forma real de cada puente 🟠 (el Pont del Passeig es un puente de arcos de hormigón). Los pasos superiores sin etiqueta (nudos de la C-58, N-150) siguen a una sola cota: la calle que cruza baja y sube en rampa limitada al 18 % 🟠; los ramales `bridge` cortos del nudo C-58/B-40 cruzan a cotas incoherentes 🔴 (herramienta). Túneles excluidos ⚪ |
| Semáforos | ✅ | 309 nodos `highway=traffic_signals` → 236 cruces del grafo señalizados |
| Pasos de peatones | ✅ | 3.971 pasos (cebra / semáforo / sin marcar) con su posición y la dirección de la calle |
| Stop / ceda el paso | ✅ | 313 cruces |
| Grafo circulable | ✅ | 5.167 nodos, 7.402 enlaces (todas las clases de `motorway` a `service`, excluidos caminos privados y aparcamientos) |

**Cómo mejorarlo:** (a) importar las calzadas del ICGC 1:5.000 para anchos exactos; (b) completar `lanes`, `width`
y `sidewalk` en OSM; (c) modelar niveles (puentes/túneles) en `road-network.js` y `city-grid.js` — el original tampoco
lo hacía dentro de Manhattan, salvo el viaducto del FDR.

### 2.3 Manzanas (`geo-blocks.mjs`)

Mismo algoritmo que el original: se rasteriza a 1 m todo el suelo, se "estampa" cada calzada con su ancho real, y lo
que queda entre calzadas son las **islas de bordillo** (manzanas). Se les calcula el contorno, la línea de propiedad
(bordillo − acera) y los solares rectangulares; las manzanas no alineadas con los ejes reciben *frontage frames*
(marcos girados a la dirección de cada calle que las bordea).

- ✅ Contorno de cada manzana (derivado del eje real + ancho modelado → 🟡 en la práctica).
- 🟡 Uso del suelo por manzana: porcentaje de parque, deportivo, bosque, matorral, cultivo, industrial, cementerio,
  ferrocarril, aparcamiento, agua, campus escolar/sanitario, plaza, césped (clases `CLS` en `geo-features.mjs`).
- 🟡 Barrio de cada manzana: nodo `place=neighbourhood` más cercano (51 barrios). Ver §2.6.

### 2.4 Usos del suelo, parques, rieras, árboles (`geo-features.mjs`)

- ✅ 1.936 polígonos de uso del suelo (38 km² de bosque en la caja: la Serra de l'Obac/Sant Llorenç entra por el norte).
- ✅ 180 parques, jardines, plazas y cementerios con nombre (Parc de Vallparadís: 28,7 ha; Parc de Sant Jordi, Parc
  del Nord, Parc dels Catalans, Plaça Vella, Raval de Montserrat...).
- ✅ Rieras y torrents a cielo abierto (Riera de les Arenes, Riera del Palau, Torrent de Vallparadís...). Ancho: 🟠
  `width` si existe; si no 28 m para la Riera de les Arenes (canal), 10 m otras rieras, 3,5 m torrents.
- ✅ 834 árboles individuales (`natural=tree`). 🔴 El resto del arbolado de alineación se genera procedimentalmente.
- ✅ Vías férreas a cielo abierto (Renfe R4 y FGC donde no van soterradas).

### 2.5 Edificios (`geo-buildings.mjs`) — ✅ Catastro + OSM

Fuente principal desde la sesión 2: **Catastro INSPIRE Buildings**. Resultado: 23.752 edificios colocados en 1.543
manzanas (1.175 con cobertura ≥ 40 %), 110.265 cajas; 1.876 edificios quedan fuera de la caja de detalle o sobre
calzada (el término municipal es mucho mayor que el área urbana), 197 ruinas descartadas. OSM solo aporta 1.711
huellas en manzanas donde el Catastro no tiene nada.

| Dato | Fidelidad | Detalle |
|---|---|---|
| Huella de cada parte de edificio | ✅ | Catastro (precisión declarada 0,1 m), cajas alineadas a la orientación dominante del edificio, error ≤ 0,25 m |
| Plantas de cada parte | ✅ | `numberOfFloorsAboveGround` por parte: un mismo edificio tiene volúmenes de distinta altura (cuerpo de 5 plantas + ático + patio de 1) |
| Altura en metros | 🟡 | plantas × altura de planta según uso/época (3,2 m residencial, 3,5 ladrillo antiguo, 4 m vapors, 5,5 naves); el Catastro no da metros. Mejora: LiDAR ICGC |
| Uso | ✅ | residencial / industrial / oficinas / comercio / equipamiento / agrario → tipología de fachada y comercios |
| Año de construcción | ✅ | elige la época de la fachada (pre-1900 estuco y ladrillo, 1900-40 modernista/noucentista, 1950-80 bloques, >1990 moderno) |
| Viviendas | ✅ | distingue casa unifamiliar (cases de cos) de bloque de pisos |
| Cubiertas | 🟠 | el Catastro no da forma de cubierta: terrat por defecto, teja según época/tipología; `roof:shape` de OSM cuando existe |
| Materiales y colores | 🔴 | por época y uso |
| Edificios procedurales | 🔴 solo residual | únicamente en manzanas sin ningún edificio catastral ni huella OSM (campos, polígonos a medio construir) |
| Comercios | 🟡 | 764 rótulos con nombre real de OSM en su portal; el resto sin rótulo o genérico |

### 2.6 Barrios

OSM tiene 51 nodos de barrio, pero no sus polígonos. La asignación "manzana → barrio más cercano" (Voronoi) es
🟠 aproximada y falla en los bordes entre barrios. **Mejora:** descargar los polígonos oficiales de barris del
portal de datos abiertos del Ajuntament y hacer un *point-in-polygon* en `build-geodata.mjs`.

### 2.7 Monumentos y edificios singulares

✅ 340 elementos con nombre y huella real (Catedral del Sant Esperit, Masia Freixa, Castell Cartoixa de Vallparadís,
Torre del Palau con `height=26.7`, Mercat de la Independència, Ajuntament, mNACTEC/Vapor Aymerich, Amat i Jover,
Hospital Mútua (17 plantas, 70 m), Estadi Olímpic, estaciones, chimeneas industriales con altura...).
🟠 Altura: solo 13 tienen `height`; el resto usa la tabla de alturas por tipo del runtime (§4.6).

### 2.8 Relieve (`geo-terrain.mjs`, `lib/geotiff.mjs`, `lib/utm.mjs`) — ✅ MDT del ICGC (5 m) + acondicionamiento urbano 🟡

**Fuente.** *Model d'Elevacions del Terreny* del ICGC a 5 m: el WCS `icc:met` de `geoserveis.icgc.cat/icc_mdt/wcs/service`
(sirve `icc:met5`, ETRS89 / UTM 31N, ARCGRID; CC BY 4.0), descargado el 2026-10-25 con autorización del propietario para
la caja de detalle + 450 m: 2.250 × 2.372 celdas, **versionado en el repositorio sin pérdida y comprimido**
(`tools/data/dem/icgc_met5_terrassa_epsg25831.asc.gz`, 22 MB; descomprimido son 96 MB y ese sí va en `.gitignore`),
para que el relieve no dependa de que el servicio del ICGC siga ahí. Para regenerar el fichero del runtime:

```bash
# el modelo está versionado comprimido (22 MB, sin pérdida) por si el servicio desaparece; para volver a bajarlo:
# curl "https://geoserveis.icgc.cat/icc_mdt/wcs/service?SERVICE=WCS&VERSION=1.0.0&REQUEST=GetCoverage&COVERAGE=icc:met&CRS=EPSG:25831&RESPONSE_CRS=EPSG:25831&BBOX=412010,4596910,423260,4608770&WIDTH=2250&HEIGHT=2372&FORMAT=ARCGRID" | gzip -9 > tools/data/dem/icgc_met5_terrassa_epsg25831.asc.gz
node tools/geo-terrain.mjs --epsg 25831 --smooth 5 tools/data/dem/icgc_met5_terrassa_epsg25831.asc.gz
```

Cota de la Plaça Vella: 278,9 m. Relieve en la caja: −100 … +510 m (la Serra de l'Obac entra por el norte). El modelo
LiDAR de 2 m del ICGC solo se sirve por WMS o por la aplicación de descarga interactiva; queda como mejora.

**Formato de salida** (`js/terrassa-terrain.bin`, 1,8 MB, **sí va en el repositorio**): cabecera de 64 bytes (`TRN1`,
w, h, celda, x0, z0, cota del origen, mín, máx, banderas, suavizado) + `Int16` little-endian en **centímetros sobre la
Plaça Vella** (914 × 995 celdas de **10 m**, margen de 400 m, suavizado gaussiano σ = 5 m) + **tabla de puentes**
(`BRDG`: índice del tramo del grafo y cota del tablero en cada extremo). El asfalto se dibuja exactamente sobre esta
retícula, así que física, deck y geometría drapeada son la misma superficie.

**Acondicionamiento urbano** (`--raw` lo desactiva). Un MDT de suelo desnudo no es el suelo por el que se conduce: baja a
los torrentes embovedados, mantiene el valle bajo los puentes y lleva ruido (montículos, hoyos) donde se quitaron los
edificios al generarlo. El runtime tiene una sola altura por (x, z) salvo en los puentes, así que la herramienta:
1. **Cotas de cruce** (`nodeHeights`): mediana, entre las calzadas que llegan al cruce, de lo que cada una daría
   **prolongada hasta él** (recta ajustada a sus 10–40 m: los primeros metros del modelo en un cruce son los más
   ruidosos); caminos y viales de servicio solo si no llega ninguna calzada. En un estribo de puente manda la cota
   **más alta** de las calzadas a menos de 45 m de camino por el grafo (OSM suele acabar el tramo de puente unos
   metros talud abajo, y el anillo de una plaza está troceado en tramos de 4–7 m: el Pont del Passeig pasó de
   11,4/8,8 m a 11,5/11,7 m en sus extremos). Los nodos solo de puente toman la media de sus vecinos. Si bajo un tablero pasa una calzada con menos de
   4,6 m de gálibo (ya 1,5 m por debajo), se **elevan los dos estribos** (máx. 5 m; 19 puentes) y las calles de acceso
   suben en rampa: nunca se excava la calle de debajo (`raiseBridgeAbutments`). Desde la sesión 4 un **estribo con
   calzadas** toma la cota de sus calles elevada al suelo más alto de las calles a 45 m pero **nunca por encima del otro
   extremo del tablero** (antes "el suelo más alto a 45 m" sin tope: dejaba 100 tableros en el aire); tras el tallado
   se **sella** una meseta de 10 m a la cota del nudo (`stampAbutments`) y el tablero toma en el estribo la cota final
   de la malla (`bridgeDecks`), así calle y tablero coinciden exactamente (0 de 254 estribos desviados). Los extremos
   de tablero a < 12 m (calzadas gemelas, ramales) se unen a una cota (`joinDeckEnds`, de nuevo tras las elevaciones
   por gálibo) y el sellado los trata como grupo; el pretil del canal de una riera se interrumpe bajo los tableros.
2. **Perfil de cada calle** (`roadProfile`): media móvil de 40 m, corrección lineal para clavar los extremos en sus
   cruces, **aplanado de crestas y hoyos cortos** (toda muestra a más de 0,3 m de la cuerda entre sus vecinas a ±15 m
   se pone en la cuerda: una calle no tiene curvas verticales tan cortas) y **limitador de pendiente** (18 % calzadas,
   45 % peatonales/escaleras) que recorta los acantilados que el modelo conserva donde la calle cruza un canal, un
   muro o una terraza. Se escribe en la malla (`carveRoads`): toda celda que toque la calzada o su acera (2 m) es
   entera de la calle, las celdas que comparten dos calles (cruces) se mezclan por cercanía a cada eje, 8 m de
   transición al exterior; en dos pasadas, la segunda **al final** (después de membranas y plataformas, así la calzada
   siempre manda) y convierte en rampa los cruces a distinto nivel sin etiqueta de puente. La zona de calle queda
   marcada (`grid.roadMask`, `grid.carriagewayMask`). 🟡
3. **Puentes** (140 tramos `bridge=yes`): **no se excavan**; son tableros rectos entre las cotas de sus estribos,
   guardados en la tabla del fichero; bajo ellos el terreno se baja al menos 0,6 m (`clearUnderBridges`). 🟡
4. **Manzanas urbanas** (≤ 260 m, 1.551): el interior es una **membrana** tendida desde la línea de bordillo
   (inversa de la distancia⁴ de muestras cada 4 m): no puede tener bultos ni hoyos respecto a sus calles
   (`membraneBlocks`). Las 155 manzanas grandes (polígonos, laderas con casas dispersas) conservan el modelo salvo una
   franja de 24 m tras el bordillo; el suelo abierto conserva el modelo. 🟡
5. **Plataforma por edificio** (`flattenBuildings`, 1.082): solo en las manzanas grandes que conservan el modelo
   (en una manzana urbana la membrana ya es lisa y una plataforma solo pone escalones entre vecinos o un montículo
   en una puerta, como se vio en Colom–Carretera de Montcada); bajo la parte interior de la huella, nunca en la
   franja junto a la calle, y **nunca por encima de la calle más baja a la que da el edificio**: las naves en ladera
   quedan sobre su terraza. 🟡
6. **Informe procedimental** sobre toda la ciudad (`report`, el propietario pidió verificación procedimental, no por
   capturas): pendientes por clase de vía (p50 2,7 %, p90 7,3 %, p99 14,5 %), tramos de calzada > 18 % (107, casi
   todos enlaces de autopista a dos niveles sin etiqueta de puente), escalones > 1 m en calzada (124), **crestas y
   hoyos cortos** en calzada (> 0,3 m respecto a una cuerda de 30 m: 1.232 muestras, eran 2.204; 612 en enlaces de
   autopista), tableros (140), escalón de bordillo por manzana (37 > 1 m, máx. 2,9 m), **montículos de acera**
   (bordillo contra línea de fachada 4 m adentro: 2.548 de 124.161 muestras > 0,5 m, 2,1 %; eran 9.727). 🟠
   Pendiente: pasos superiores sin etiqueta, túneles, tramos cortos entre cruces a distinta cota, lo que la malla de
   10 m no puede representar (la acera de una calle de 6 m y el interior de su manzana caen en la misma celda).

**Lector propio de GeoTIFF / ASC** (`tools/lib/geotiff.mjs`): sin GDAL ni dependencias npm. Clásico y BigTIFF, tiras o
teselas, compresión none / deflate / LZW / PackBits, predictores 2 y 3, enteros de 8–32 bits y flotantes de 32/64,
georreferencia por `ModelPixelScale`+`ModelTiepoint` o `ModelTransformation`, EPSG por GeoKeys, `GDAL_NODATA`; ASCII grid
de Arc/Info. Proyección directa UTM (GRS80) en `tools/lib/utm.mjs`. El marco del mundo se lee de `GEO.frame`. Tests:
`tests/geo-terrain.test.mjs` (escribe TIFFs sintéticos de cada variante y los lee), `tests/terrain.test.cjs` (runtime).
`--synthetic` genera un relieve inventado marcado en la cabecera, solo para desarrollo sin datos.

---

## 3. Diario de desarrollo

### 2026-10-25 — Sesión 4 (tarde): conducción tipo simulador, colisiones con el mobiliario, policía con criterio

Petición del propietario: físicas de conducción "mucho más tipo simulador" (y, como en los simuladores, **cada rueda
amortiguada e independiente**), no atravesar árboles ni farolas, policías sin sirena y coches de los Mossos, elegir
entre varios coches con su aceleración/giro/potencia, bajar y subir del coche, bicis aparcadas, libreas verosímiles.
Todo detrás de conmutadores nuevos en `FEATURES` (`city-config.js`): `carPhysics`, `propCollisions`, `vehicleGarage`,
`enterExit`, `emergencyStates`. Decisiones: `VDR/0028`–`0033`.

1. **Modelo de conducción propio** (`js/vehicle-physics.js`, aritmética pura sin three.js, `VDR-0028`): cuerpo rígido
   en el plano con **cuatro muelles-amortiguador independientes** (deflexión de cada rueda respecto a su altura
   estática, barra antibalanceo por eje, carga de cada rueda = precarga + fuerza del muelle, así la transferencia de
   carga sale sola), cabeceo/balanceo/bote del chasis sobre el plano ajustado a las cuatro alturas de contacto,
   neumáticos con ángulo de deriva y fórmula mágica de Pacejka (pico = μ·carga), círculo de fricción (rueda bloqueada o
   patinando pierde agarre lateral), ABS/TCS por vehículo, freno de mano que bloquea el eje trasero, curva de par +
   cambio automático de 6 marchas con corte de par al cambiar + retención, reparto fwd/rwd/awd, arrastre aerodinámico,
   rodadura y **gravedad a lo largo y a lo ancho de la pendiente real** (el MDT ya existente), dirección limitada en
   velocidad angular y con tope decreciente con la velocidad; subpasos a 240 Hz. Medidas con los tests
   (`tests/vehicle-physics.test.cjs`, 14): taxi 0–100 km/h en 11,6 s, esportiu 5,0 s, SUV 9,5 s; frenada 50→0 en
   8,7–10,7 m con picado de morro; ~0,7 g en curva con el chasis inclinado hacia fuera; en un 8 % el automático en D
   aguanta parado, en un 20 % se va hacia atrás; un bordillo bajo un lado inclina el coche y carga ese lado.
   Convenciones de signos documentadas en la cabecera del módulo (el +x local del coche es su **izquierda**, como el
   intermitente "left (+x)" del tráfico).
2. **Integración** (`controllers.js updateCarPhysics`): W acelera, S frena y, mantenida parado, mete marcha atrás
   (entonces S acelera hacia atrás y W frena), A/D dirección, **Shift = freno de mano** (antes turbo). Las colisiones
   (edificios, props, tráfico) siguen escribiendo `speed`/`vx`/`vz`/`angularVel` en la entidad y el modelo las absorbe
   cada fotograma; la respuesta contra pared se reescribió para el modelo (quita la velocidad de aproximación con un
   pequeño rebote, frota la componente deslizante, gira sobre el contacto) porque la antigua sumaba dos impulsos que el
   modelo nuevo no amortiguaba (medido: el coche salía a 8 m/s hacia atrás tras chocar a 12 m/s). La raíz del coche
   sigue el plano del suelo (pendiente), el pivote del chasis va sobre los muelles, **cada rueda sobre su propio
   suelo**. HUD: marcha (R/N/D1–D6) y cuentarrevoluciones junto a la velocidad; escala del velocímetro = `topSpeedKmh`
   del vehículo.
3. **Catálogo de vehículos** (`VEHICLE_CATALOGUE`, `VDR-0029`): taxi (berlina híbrida blanca con franja y luminoso),
   compacte, SUV familiar (awd, centro de gravedad alto), Policia Municipal (berlina, librea 1), Mossos d'Esquadra
   (SUV, librea 2), esportiu (221 kW awd sin TCS). Sin marcas reales: arquetipos con cifras del rango de su clase.
   `applyVehicle()` reconstruye el coche del jugador a partir de la ficha (carrocería, calcas, matrículas, faros,
   ruedas, puente de luces) y `setVehicle(id)` lo cambia en el sitio; selector `#vehicle-picker` sobre la barra de
   modos, tecla `G`, guardado en `terrassa-player-state.vehicle`. Las medidas de colisión (`halfW`/`halfL`) salen de la
   ficha y `traffic.js` las lee de la entidad (antes 0,86 × 2,18 fijos).
4. **Colisiones con el mobiliario y los árboles** (`VDR-0030`): `street-details.js` y `city-grid.js` exportan al final
   `obstacles` (cilindros leídos de las **matrices de instancia**: columnas, postes, semáforos, pasos de peatones,
   pals de placas, bolardos, papeleras; troncos = radio de la especie × escala + 4 cm) y `propBoxes` (bancos como OBB
   en el formato de los colisionadores de edificios). `controllers.js`: celdas de 48 m, contacto rectángulo orientado
   vs cilindro para el coche y círculo vs cilindro para peatón y bici, empuje, impulso según velocidad de
   aproximación, giro sobre el contacto, sacudida de suspensión, chispas, aviso `'prop'` al audio; las papeleras ceden
   (0,45), los postes no. Teletransportes e `isClearAt()` los respetan. Medido con el arranque: ver cuenta en la
   consola `[controllers] N prop colliders`.
5. **Policía con estados y dos cuerpos** (`traffic.js`, `actor-models.js`, `audio-sources.js`, `VDR-0031`): cada coche
   policial tiene `corps` (1 Policia Municipal, berlina; 2 Mossos, SUV; alternos), `emergency`/`siren`/`priority`. Por
   defecto **patrulla**: puente apagado, sin sirena, respeta semáforos como cualquiera (las seis reglas de prioridad
   que leían `isPolice` leen `priority`). Primera versión: una **emergencia** aleatoria cada 2,5–5 min; el propietario
   la rechazó en la prueba ("no te he pedido que la poli encienda aleatoriamente las luces") y se quitó: ahora nada
   arranca solo, solo `__slop.traffic.startEmergency()` desde la consola manda a la patrulla más cercana a una
   emergencia de 40–90 s (`VDR-0034`). Puente de luces con atributo por
   instancia `barLit` (una malla instanciada por carrocería). Librea Mossos: blanco con banda azul oscura ancha sobre
   las puertas, línea roja en el borde superior y letras blancas (de memoria, sin foto: 🟠). El coche policial del
   jugador enciende puente + sirena con `L`.
6. **Subir y bajar** (`VDR-0032`): `F` baja del coche (por la puerta del conductor, lado izquierdo) o de la bici y
   deja el vehículo parado; `F` junto al coche o la bici vuelve a subir; junto a una **bici aparcada** la toma del
   soporte. Mientras se conduce el peatón está oculto (y mudo), mientras se camina el ciclista y el casco están
   ocultos (la bici queda sola); el peatón ya no pasea solo. Botón "Get in / Get out" en la barra de modos para
   táctil. Los modos 1–4 siguen funcionando.
7. **Bicis aparcadas** (`js/parked-bikes.js`, `VDR-0033`): soportes de U invertida con dos bicis, sembrados alrededor de
   las plazas, los puntos de teletransporte (monumentos, estación) y una de cada cuatro barras de bar, solo en islas
   con acera y libres de edificios y props, barra paralela a la calle y bicis con el morro hacia dentro; malla
   instanciada con colores por instancia. Procedurales: no hay inventario de aparcabicis descargado (🟠).
8. Primera ronda de pruebas del propietario (servidor local, Chrome): (a) las emergencias aleatorias de la policía no
   se habían pedido → quitadas (punto 5); (b) las libreas de Mossos, Policia Municipal y taxi hechas de memoria no
   valen: han de ser realistas y de los últimos modelos → **con permiso del propietario** se buscaron y descargaron
   fotos de referencia (Wikimedia Commons, prensa local, nota de Toyota España; fuentes en §5.1) y se **repintaron las
   tres libreas** en `actor-models.js` (`createLoftedCarMaterial`) y la calca del taxi del jugador (`controllers.js`):
   el taxi de Terrassa resultó ser blanco liso con "píxels" rojos y escudo, no la franja diagonal inventada; la
   Policia Municipal lleva las puertas azules con rombos y franja fluorescente; los Mossos el capó azul marino, la
   banda con cortes blancos y rojos y el ajedrezado rojo/blanco. Regla nueva: ninguna librea de memoria (`VDR-0035`);
   (c) **tras meter marcha atrás no se podía volver a D**: en R los pedales se intercambian (S acelera, W
   frena) y el modelo exigía acelerador para volver a D, pero W era freno; ahora, parado y con solo W pulsada, W pide D
   y arranca hacia delante (`updateCarPhysics`, test nuevo en `tests/controllers.test.cjs`).
9. Segunda ronda del propietario: letras "a veces cortadas o giradas como en un espejo", los Mossos aún lejos de la
   foto, y "todos los puentes de autopistas y de la Mútua son horribles: color, mal conectados". Con su autorización se
   ejecutó por fin la **prueba de humo headless** (`tools/browser-smoke.mjs`, ahora con `--teleport`/`--eval`/`--shot`
   en orden y `__slop.selectCamera/selectMode/bridges`) para verlo: (a) las letras salían en espejo en los dos lados y
   en el capó: la convención de lectura estaba al revés (de pie en el lado izquierdo del coche, +x local, el morro
   queda a la **izquierda** del observador); corregido y comprobado en captura; (b) el ajedrezado de los Mossos quedaba
   bajo la moldura negra del SUV (`cladding` 0,5 m): ahora se apila sobre la zona pintada (ajedrezado, texto, banda);
   (c) **puentes**: medidos con Node sobre la tabla real, 81 de los 280 extremos de tablero quedaban a más de 0,3 m del
   terreno en su nudo (algunos a 5–12 m: nudos de viaducto partidos en varios tramos, o estribos sobre la zanja de la
   calle que cruza por debajo). Arreglos en el runtime (`VDR-0036`): primero, **todo extremo en un nudo con calles
   (estribo) se pone a la cota de la calle** (`terrain.js fitAbutments`: 100 de los 254 estribos estaban a más de 0,3 m,
   el Pont del Passeig 1,4 m por encima del Passeig; se aceptan desvíos hasta 2,5 m); solo los 14 restantes (calle
   excavada bajo el mismo extremo, 2,6–7,4 m) se **prolongan en horizontal hasta donde el suelo vuelve a subir** o bajan
   en **rampa del 9 %** (`addRamps`, 13 prolongaciones; `deckY` lineal a trozos por vértice). La primera versión
   prolongaba también los estribos desviados 1–2 m y alargó los pretiles del Pont del Passeig 36 m calle adentro: el
   propietario lo vio y se corrigió el mismo día;
   `city-grid.js buildBridgeGeometry` dibuja **muros de contención** donde el tablero va a menos de 3 m del suelo,
   **pilas** rectangulares cada 22 m bajo los vanos altos, un muro de estribo donde aún cuelga un extremo, arcenes de
   hormigón en vez de aceras en autopista (`cls` 1), y el hormigón pasa de 0x9c9990 (casi blanco al sol) a 0x7e7b76
   con pretiles 0x8c8983. Comprobado en capturas: Pont del Passeig, Av. del Vallès sobre la Ctra. de Terrassa, N-150,
   C-58. ⚪ Queda feo el **nudo de la C-58/B-40**: tramos `bridge` cortos con 3–4 m de desnivel en 15 m y ramales que
   se cruzan a cotas incoherentes; eso hay que arreglarlo en la herramienta (`geo-terrain.mjs`, cotas de nudos de
   solo-puente). (d) **Peatones que desaparecían al acercarse**: `renderPed` los recortaba con el frustum a y = 1
   absoluto, no a su altura real sobre el relieve (lo mismo que ya se había arreglado en los coches con `groundPose`):
   ahora `visible(..., pedGround(p) + 1)`. (e) **Chispas de colisión demasiado altas**: `lastCollisionSpark.y` era 0,5
   absoluto (ciudad plana); ahora `pos.y + 0,5` sobre el relieve.
10. Tercera ronda del propietario sobre el Pont del Passeig: "desniveles y huecos vacíos en sus extremos, no quiero
   aberraciones". Mirado de cerca con la prueba de humo (ambos extremos desde la calle, desde el parque y por debajo):
   el tablero tenía la cara de los extremos abierta (se veía el hueco de la losa) y el muro lateral solo llegaba al
   canto, dejando aire entre el canto y el talud. Dos arreglos: (a) **la herramienta** (`tools/geo-terrain.mjs
   nodeHeights`): un estribo con calzadas ya no toma "el suelo más alto a 45 m" sino la cota de sus propias calles en
   el nudo (nunca por debajo del suelo de la calle a 8–10 m, por si OSM acaba el tramo de puente talud abajo); el
   fichero `js/terrassa-terrain.bin` se **regeneró** con el MDT archivado (estribos desviados > 0,3 m: de 100 a 7, todos
   enlaces de autopista; `fitAbutments` del runtime queda como red de seguridad); (b) **la geometría**
   (`city-grid.js buildBridgeGeometry`): el tablero se remuestrea cada 4 m en anillos que leen el suelo bajo cada
   borde; donde la losa va a menos de 3 m del suelo los laterales bajan como muros que siguen el terreno anillo a
   anillo (muros en ala), donde un tramo en tierra pasa a vano se cierra un **frente de estribo** de lado a lado, y
   los dos extremos llevan una **tapa** del pretil al suelo: ningún tablero enseña ya la losa hueca ni deja aire bajo
   el canto. El Pont del Passeig arranca a ras de la Plaça del Doctor Robert por el este; por el oeste el tramo
   `bridge` de OSM acaba 36 m antes del Passeig, 2,2 m más abajo, y la calle entre ambos baja al 6 % (continua, sin
   hueco; si el Passeig real es llano hasta el puente, la cota del nudo 240 del MDT es la que engaña 🟡).
11. Cuarta ronda ("¿tú lo has probado?"): el propietario vio **muros en los dos extremos** (atravesables), un hueco a
   la derecha saliendo hacia Jacquard y el asfalto de otro color. Método corregido: desde aquí cada puente se prueba
   **circulando con el coche por encima en los dos sentidos** con capturas cada 2 s (`--eval` que teletransporta,
   `setTouchInput('forward')` y `--shot`), más a pie en los testeros y a mediodía para el color; no solo capturas
   estáticas desde fuera. Causas y arreglos: (a) los muros eran mi tapa de los extremos levantada hasta el pretil:
   ahora la losa se tapa hasta la calzada y, aparte, se tapan los testeros de las **aceras** y de los **pretiles**
   (antes abiertos: el "hueco"); (b) **el asfalto del puente era invisible**: los cuadriláteros de la calzada estaban
   enrollados en sentido horario y el material del asfalto es de una cara, así que se veía la **losa de hormigón** de
   debajo (de ahí el color marrón y las aceras "altas"); `quad()` comprueba ahora el sentido con el producto vectorial;
   a mediodía el asfalto del tablero y el de la calle son idénticos; (c) el **bache** del estribo oeste: la mezcla de
   perfiles en los cruces de `carveRoads` (pesos 1/(d+2)) promediaba la salida del aparcamiento subterráneo (2,8 m más
   baja, a 4 m) con el Passeig y hundía el estribo 1,1 m; además `clearUnderBridges` rebajaba la celda de 10 m pegada
   al nudo (`end` 4 → 12 m). En la herramienta: los estribos con calzadas se elevan a la cota de la calle cercana sin
   pasar nunca de la cota del otro extremo del tablero (`nodeHeights`, segunda pasada), se **sellan** con una meseta de
   10 m + 10 m de mezcla a la cota del nudo después del tallado (`stampAbutments`, 3.209 celdas) y la tabla de puentes
   lee la cota final de la malla en el estribo (`bridgeDecks`): 0 de 254 estribos desviados > 0,3 m; el Pont del
   Passeig queda a 11,35 → 11,30 m, llano de la Plaça del Doctor Robert al paso de cebra del otro lado. Medido
   circulando: el coche va de 11,3 a 11,5 m de cota en todo el tramo, sin escalón, en los dos sentidos.
12. Quinta ronda: "pequeños huecos" a los lados del extremo del hospital, "prueba otros puentes y autopistas", y
   "crestas a lo largo del asfalto en las afueras". **Huecos laterales**: el sellado del estribo era un círculo de
   10 m y el terreno caía antes de llegar a las esquinas de un tablero de 19 m; ahora es un **rectángulo** del ancho del
   tablero + 3 m (de 8 m calle adentro a 12 m bajo el tablero) con 10 m de mezcla (`stampAbutments`); medido 1,5 m
   fuera del pretil, el suelo queda a 0,4 m del tablero en el extremo. **Auditoría de los 140 puentes** con Node
   (`scratchpad/audit.cjs`: muescas laterales, escalones de acceso, crestas transversales y longitudinales) y
   **recorrido en coche** de 12 de ellos en los dos sentidos con un gancho que registra cada colisión
   (`setCollisionListener`): (a) **Pont de les Arts**: el coche se paraba contra el **pretil del canal de la Riera del
   Palau**, que seguía bajo el tablero como colisionador; ahora `buildWaterBlock` deja hueco en el pretil donde
   `bridgeAt` encuentra un tablero; (b) **Carretera de Terrassa sobre la Av. del Vallès** (y Pont de les Arts): las dos
   calzadas de una **autovía de doble calzada** son dos tableros paralelos a 8–10 m que se solapan: el pretil interior
   de cada uno quedaba dentro de los carriles del otro (colisión invisible a 33 km/h). `buildBridgeGeometry` detecta
   con `bridgeAt` un tablero vecino a 1 m del borde y en ese lado suprime acera, pretil y colisionador y lleva el
   asfalto hasta el canto: los dos leen como un puente con mediana; (c) en la herramienta, `raiseBridgeAbutments`
   subía un estribo (gálibo del paso inferior) sin su gemelo: `joinDeckEnds` (extraído de `nodeHeights`) se vuelve a
   pasar tras las elevaciones con el máximo del grupo; el sellado trata los extremos a < 12 m como un grupo (no se
   respetan mutuamente como "otras calzadas") y fuerza solo el cruce en sí (de 8 m calle adentro a 2 m bajo el
   tablero): forzar todo el ancho hasta 12 m bajo el tablero izaba 8–10 m la Avinguda de Joaquim de Sagrera, que pasa
   bajo la N-150 a 13 m de un estribo. **Residuo honesto**: en la Ctra. de Terrassa los dos tableros gemelos siguen
   1,2 m desfasados entre sí porque la Av. del Vallès pasa por debajo a 8 m del estribo de uno de ellos y la malla de
   10 m no puede tener a la vez el estribo y el paso inferior en la misma celda (el coche pasa; se ve el canto de un
   tablero sobre el otro). **Crestas**: la auditoría no encuentra coronas de asfalto (centro por encima de ambos
   bordes > 0,25 m) en calles ordinarias lejos de autopistas y puentes salvo 2 de 0,3 m (Carrer del Gall, un vial de
   Les Carbonelles); los "cresta/valle" reales (1.284 muestras > 0,3 m sobre una cuerda de 30 m) se concentran en los
   **nudos a dos niveles sin etiqueta de puente** (C-58/N-150/C-16 con la Rambleta del Pare Alegre y la Av. de
   Joaquim de Sagrera, Ronda de Ponent en trinchera con sus calles transversales, Av. de Santa Eulàlia) y en las
   calles de ladera con plataformas de edificios (Carrer de l'Avellaner): es el punto 1 de "Lo que queda" del relieve
   (`NEXT_STEPS.md` §1.1), no un defecto nuevo. Pendiente que el propietario señale un sitio concreto si ve una cresta
   fuera de esas zonas.
13. **Cámara del peatón al arrastrar** ("el personaje pierde el foco"): la cámara de seguimiento orbitaba alrededor
   del personaje pero miraba a un punto 5,2 m por delante de su rumbo, así que a 90° de órbita el peatón se iba al
   borde del encuadre. Ahora el punto de mira adelanta a lo largo del rumbo de la **cámara** (0,9 m a pie, 2,6 m en
   bici, 5,2 m en coche): el personaje queda centrado se mire desde donde se mire, como en un juego en tercera
   persona (`cameras.js`, preset `chase`; comprobado con capturas a 0°, 90° y 180° de órbita).
14. Sexta ronda: "policia" del capó al revés, sirenas y luces tipo simulador con modos, intermitentes en todos los
   coches, trasera de los Mossos en blanco. (a) **Capó**: la palabra se leía desde el asiento del conductor; en las
   fotos (Arona, Altea) se lee **desde delante**: `wordBonnet` da la vuelta a u y v (letras con la parte alta hacia el
   parabrisas). (b) **Trasera de los Mossos**, con dos fotos más de Wikimedia Commons (SEAT León CME 9347 de espaldas,
   Ford Kuga de tres cuartos trasero): banda azul marino en el portón entre los pilotos con **"www.mossos.cat"** en
   blanco (leído desde atrás: `wordRear`), **ajedrezado rojo y blanco** en la parte baja del portón sobre la línea del
   paragolpes. Siguen sin hacer: el "policia" + senyera de la luna trasera (la luna es parte WINDOW), el "112
   emergències" de la ventanilla trasera, el número de techo. (c) **Puente de luces por módulos y modos**
   (`createLightbarMaterial`): la barra lee como 8 módulos LED con junta oscura; `barLit` ya no es 0/1 sino el modo:
   0 apagado, **1 posició** (todo fijo atenuado), **2 prioritari** (mitades alternas con doble destello, el "pont
   alternant" clásico), **3 emergència** (pares exteriores e interiores en ráfagas triples más un barrido de punta a
   punta). El coche del jugador lleva además dos luces puntuales azules bajo el puente que siguen la cadencia
   (`updateCarLights`); el tráfico en emergencia usa el modo 3. (d) **Sirenas españolas conmutables**
   (`audio-synthesis.js SIREN_KINDS`): bitonal, wail, **yelp** (barrido a 3,2 Hz) y **phaser** (9 Hz, estrecho);
   `K` las recorre y `L` recorre los modos de luz, independientes entre sí (la sirena cambia de voz al instante:
   `audio-system.js` rehace la voz si cambia el tipo). Los Mossos del tráfico usan el wail y la Policia Municipal el
   bitonal. (e) **Intermitentes** en todos los coches del jugador: `Q` izquierdo, `E` derecho, `X` emergencia
   (`setTurnSignal`; `carState.y/z` que el material ya pintaba para el tráfico); se cancelan solos tras girar unos 50°
   con el volante recto. Segunda línea del cuentakilómetros con el estado (modo de luz, sirena, intermitente). Todo
   comprobado en capturas: capó de frente, trasera, modos 2 y 3, intermitente del taxi.
15. Séptima ronda: trasera blanca y rombos de la Policia Municipal, sirenas "no españolas", destellos "breves
   entre sí". (a) **Destellos**: medidos, el modo emergència parpadeaba a 31 Hz (12 subdestellos por ciclo de 2,6 Hz):
   invisible, leído como un brillo. Patrones rehechos con tiempos que el ojo resuelve y **compartidos** entre el shader
   y las luces puntuales (`LIGHTBAR_PATTERN`): prioritari a 1 Hz con doble destello de 90 ms por mitad; emergència a
   1,25 Hz con ráfagas triples de 60 ms encendido / 60 apagado, pares exteriores y luego interiores, más un barrido.
   Prueba nueva `tests/lightbar.test.cjs` que mide las duraciones (destellos 50–70 ms, pausas, alternancia sin
   solape). (b) **Policia Municipal**: la foto de La Ciutat (29-1-2024) de los **nueve Ford Kuga** ante el Ajuntament
   muestra la **imagen corporativa nueva**, no la de los Prius+ de 2019 que estaba pintada: puertas blancas con
   "policia municipal" en azul, aleta delantera y aleta trasera en **amarillo fluorescente** cerradas por un bloque
   azul inclinado, **ajedrezado azul/blanco por los estribos** con los extremos en diagonal, capó azul con "policia" en
   blanco y borde delantero amarillo. Repintado así (`createLoftedCarMaterial`, livery 1). **La trasera no está
   fotografiada**: lleva el ajedrezado y la banda azul continuando los lados, marcado 🟠 hasta tener una foto de
   espaldas (pedida al propietario). (c) **Sirenas**: no puedo escucharlas; retocadas con los únicos datos
   documentados (familia hi-lo europea: 780/980 Hz UK, 440/550 Alemania, 435/580 Francia, 0,5–1,5 s por nota;
   sirengenerator.com) hacia lo que caracteriza a las españolas: bitonal **más grave y lenta** (590/760 Hz, 0,75 s por
   nota) con **glissando** de ~60 ms entre notas (filtro paso-bajo sobre la onda de control), timbre de bocina con
   resonancia a 1,15 kHz; wail 500→1300 Hz en 4 s; yelp 3,3 Hz; phaser 10 Hz. Sigue siendo síntesis aproximada (🟠):
   con una grabación (.wav/.mp3) del propietario se pueden medir frecuencias y cadencias y ajustar.
16. Octava ronda: "el patrón de emergència se confunde, se superpone el que va de derecha a izquierda". Cierto: el
   barrido corría a 1 Hz sobre las ráfagas de 1,25 Hz y, descompasados, el ojo perdía el patrón. El barrido **sale del
   modo emergència** (que queda limpio: ráfagas triples exteriores → interiores) y pasa a ser el **modo 4 escombrat**
   (un módulo recorre la barra ida y vuelta en 1,2 s, el "traffic advisor" de una unidad parada). `L` recorre ahora
   cinco modos. Test de que el escombrat nunca enciende las dos mitades a la vez. Sobre las sirenas: el propietario las
   sigue oyendo raras y pregunta por el **tritono**; lo documentado (El Economista 2025 sobre el estándar de las
   ambulancias; sin fuente específica de Mossos ni de policías locales catalanas) sitúa el tritono/hi-lo-yelp como
   repertorio de las ambulancias y el yelp/wail como el de policía; sin grabación no se añade nada más (🟠, ver §5.1).
17. Novena ronda: la sirena "suena súper apagada y no realista" y no hay grabaciones. Causa: en la ronda 7 bajé el
   paso-bajo de la bocina a 3 kHz y el nivel a 0,09; una bocina electrónica real es brillante y áspera. Voz devuelta a
   brillante (paso-bajo 7 kHz, resonancia a 1,8 kHz +6 dB, nivel 0,16) con el bitonal en 700/930 Hz a 0,8 Hz y
   glissando de 40 ms. Y, como yo no la oigo y el propietario sí, los parámetros pasan a un objeto **afinable en
   caliente** desde la consola (`SIREN_TUNING` en `audio-synthesis.js`, expuesto como `__slop.sirenTuning`): notas,
   cadencia, glissando, brillo, resonancia y nivel del bitonal; extremos del barrido, velocidades de wail/yelp/phaser,
   brillo y nivel. El acuerdo es que el propietario encuentre los números de oído y se fijen como valores por defecto.
18. Verificación: `node --test 'tests/**/*.test.*'` → **160 pruebas en verde**; prueba de humo headless sin errores de
   consola; recorridos en coche con gancho de colisiones: Pont del Passeig, Av. de Béjar, Ctra. de Martorell, Pont de
   les Arts (ambos sentidos, sin golpes), Ctra. de Rellinars, Av. de l'Abat Marcet, Ctra. de Terrassa (ambos sentidos,
   solo roza el pretil exterior al cambiar de calzada), N-150, C-16, B-122; testeros y laterales del Passeig a pie y a
   4 m de altura (133 + 14 de físicas + 7 de controlador
   nuevas; 3 de tráfico adaptadas a `priority`); `node --check` de todos los módulos tocados. **Pendiente la prueba de
   humo en el navegador** (`tools/browser-smoke.mjs` carga three.js del CDN: requiere permiso para la petición de red).

### 2026-10-25 — Sesión 3 (madrugada): relieve

1. Se empieza por `NEXT_STEPS.md` §1.1 (relieve real) en la rama `terrain`, detrás de `FEATURES.terrain`
   (`js/city-config.js`). Sin permiso aún para descargar el MDT del ICGC, todo se desarrolla y prueba con un relieve
   **sintético** marcado como tal (§2.8).
2. Pipeline: `tools/geo-terrain.mjs` + lector GeoTIFF/ASC propio + proyector UTM. Runtime: `js/terrain.js`
   (`terrainY`, `terrainGradient`, `refineGeometry`, `latticeCapGeometry`, `drapeGeometry`, `buildTerrainTiles`).
3. Integración: `groundHeightAt()` (`city-grid.js`) = altura local + relieve: el único punto de verdad. Deck en
   losetas de 500 m sobre la retícula del relieve; losas, bordillos, bancales, vallas y caminos drapeados vértice a
   vértice; bordillos como muro exterior + tira superior; edificios asentados en la cota mínima de su huella
   (`buildings.js`, con el atributo `base` por instancia para que las hileras de ventanas no se desplacen,
   `tsl-materials.js`); monumentos por `Sink.base` (`landmarks.js`); pintura vial troceada a 6 m (`road-paint.js`);
   tráfico con cota y cabeceo según la pendiente (`traffic.js`); coche del jugador con cabeceo/balanceo de pendiente
   (`controllers.js`); mobiliario, árboles, placas y luces elevados (`street-details.js`); terreno regional fusionado
   con el real y recortado bajo el deck (`surroundings.js`); carga del fichero antes de construir (`main.js`).
4. Primera prueba en el navegador del propietario: **pantalla negra**. Causa: el refinado por bisección de aristas
   convertía las aceras en 9 M de triángulos (un búfer de 331 MB por encima del `maxBufferSize` de WebGPU, 256 MB) y
   20 s de construcción. Solución: recorte de cada triángulo contra la **retícula del propio deck** (líneas x, z y
   diagonales), geometría indexada con vértices compartidos, caras inferiores descartadas, losas construidas
   directamente sobre la retícula (`latticeCapGeometry`). Medido en Chrome headless: vértices del suelo de ~23 M a
   ~7 M, `cityGrid` de 20 s a ~4,5 s (0,5 s sin relieve), 0 errores de WebGPU.
5. Segunda ronda de pruebas del propietario (con el relieve sintético): calzadas que se hunden en los puentes,
   edificios enterrados, farolas flotando, sonido que se iba con la cota, cámara en tercera persona por encima del
   coche. Diagnóstico y arreglos: (a) acondicionamiento urbano del relieve en la herramienta (calles escritas con su
   perfil, puentes como rampas, manzanas como planos robustos, §2.8); (b) celda de 10 m y deck/drapeado alineados
   exactamente con la retícula del relieve (farolas y losas coinciden); (c) dos suelos absolutos de la cámara
   (`Math.max(0.65, y + h)`) sustituidos por el suelo bajo la cámara (`cameras.js`); (d) altura sobre el relieve en el
   audio: vehículos del tráfico, peatones, helicóptero (`audio-sources.js`); (e) patios de manzana como losas de
   2,5 m de canto (muro de contención en vez de borde flotante). El error `points[l-1].equals is not a function` fue
   un `Vector2` que faltaba en `triangulateShape`.
6. Prueba de humo headless nueva: `tools/browser-smoke.mjs` (Chrome por DevTools Protocol sin dependencias; espera el
   `[init]`, teletransporta por el gancho `window.__slop`, captura pantallas y evalúa expresiones). Con ella se midió:
   75.342 volúmenes de edificio, 8.0 k enterrados > 1 m y 2.1 k > 2 m en el relieve **sintético** (zanjas verticales
   de 9 m que cruzan manzanas; se espera mucho menos con el MDT real), 178 "flotantes" > 0,3 m (casi todos artefactos
   de medir esquinas AABB de edificios girados junto a las zanjas).
7. **MDT real** (autorización del propietario): WCS del ICGC, 5 m (§2.8). Con datos reales afloraron los problemas de
   un acondicionamiento ingenuo: pendientes imposibles (p99 del 38 %), escalones de 17 m en bordillos (tope del 6 %
   absurdo en barrios de ladera), 11.900 volúmenes enterrados > 2 m. Rehecho: cotas robustas por cruce, perfiles
   anclados con limitador de pendiente, puentes como **tableros** (tabla en el fichero, `bridgeAt`/`surfaceY` en
   `terrain.js`, `groundHeightAt(x, z, hint)` elige el nivel más cercano al que pregunta, tráfico y peatones por el
   `bridge` de su arista, tablero con calzada de asfalto, aceras, pretiles y colisionadores en `city-grid.js`),
   membrana por manzana y plataforma por edificio.
8. **Asiento de los edificios** (regla del propietario: "si sabemos su forma, ha de empezar desde el suelo, siempre",
   sin apaños): cada **volumen** (no cada edificio: un registro rural del Catastro reparte construcciones a cientos de
   metros) se asienta en la cota **más alta de sus fachadas a la calle**; si no tiene fachada, en la mediana de sus
   esquinas; un volumen superior toma el de abajo. Debajo, un **zócalo ciego** hasta el punto más bajo del terreno bajo
   su huella (nada flota). Las fachadas de más de 18 m que suben más de 1 m se **escalonan**. Los monumentos, en el
   percentil 90 de su contorno con zócalo de hormigón. Métrica final (navegador): 115.517 volúmenes, 50.962 zócalos
   (1.559 > 3 m), 2.134 escalones, 1.617 volúmenes con la trasera enterrada > 2 m (naves en ladera y polígonos del
   oeste, donde las plataformas no entran en la franja de calle).
9. Errores encontrados por el propietario y corregidos: postes y placas de calle elevados dos veces
   (`groundY` ya traía el relieve y `pushMatrix` lo sumaba de nuevo), árboles de parque elevados dos veces
   (`parkTreeSites` → `treePositions`), `Vector2` en `triangulateShape`, parpadeo en los puentes (pintura vial
   recortada con la misma retícula que el asfalto, gap bajo los tableros, caras coplanarias del pretil), asfalto del
   tablero de otro color, tablero inclinado por un camino que bajaba al parque (cotas de estribo), **montículos en
   aceras** (plataformas de edificio invadiendo la franja de acera: ahora la acera es plana en su anchura y la
   plataforma solo entra bajo el interior del edificio), cámara y audio con cotas absolutas.
10. Segunda ronda del propietario: montículo en Colom–Carretera de Montcada (plataforma de edificio en manzana
    urbana: ahora solo en manzanas grandes y nunca sobre la calle de la puerta), placas de calle aún dobles
    (`addPlaque` sumaba el relieve y `pushMatrix` otra vez), **gente volando en el punto de aparición** (eran los
    modos aparcados del jugador: el ciclista y el peatón se creaban a y = 0; `spawnAt` ya asienta en el relieve),
    chispas de colisión en la cota 0 (ahora a la del vehículo), **vehículos y peatones que desaparecían antes de
    cruzarse** (la prueba de frustum del tráfico suponía el suelo a y = 1: ahora usa la cota real), **crestas en
    calles** (cotas de cruce por extrapolación, aplanado de crestas cortas, celdas enteras para la calle, mezcla en
    cruces, calzada escrita al final, estribos elevados en vez de excavar la calle de debajo). Tercera ronda:
    el Pont del Passeig inclinado (estribo de la Mútua leído en tramos de 4–7 m: ahora se recorren 45 m del grafo)
    y el coche "haciendo cosas raras" sobre él: cabeceaba y balanceaba con el gradiente del **terreno** (el valle
    bajo el puente), ahora con la superficie que pisa (`getGroundHeight` con su propia cota como pista, ±1,4 m).
11. Pendiente: pasos superiores sin etiqueta `bridge` (C-58, N-150: hoy rampas limitadas al 18 %), túneles, pilas y
    arcos de los puentes, cámara de persecución sin colisión con edificios (preexistente, se nota más en laderas),
    gravedad en pendiente (§2.1.2), MDT de 2 m, lo que la malla de 10 m no resuelve (acera e interior de manzana en
    la misma celda en calles estrechas). Tests: 133 en verde.

### 2026-10-24 — Sesión 2 (misma tarde)

1. Primer arranque en el navegador del propietario: demasiados edificios inventados, falta de detalle. Diagnóstico:
   el 75 % de los edificios no existe en OSM. Decisión: **Catastro INSPIRE** como fuente principal de edificios y
   **comercios de OSM** para los rótulos. Descargas autorizadas y realizadas (`tools/catastro-to-json.py`,
   `tools/data/q_shops.overpassql`).
2. `geo-buildings.mjs` reescrito: Catastro primero (partes con plantas propias, uso, año, viviendas, referencia
   catastral), OSM de relleno. 110.265 cajas (antes 35.858).
3. `buildings.js` consume el nuevo esquema (plantas por volumen, época de fachada, rótulos reales de 547 comercios,
   procedural solo en 207 manzanas vacías). 107 tests en verde. Masia Freixa: pendiente de fotos de referencia.
4. Validado en el navegador por el propietario ("me encanta como va mejorando"). Segundo push a `slop-egara`.
5. Incidencia: edificios reales sin renderizar (p. ej. la comisaria de la Policia Municipal, Avinguda de les Glòries
   Catalanes) y placas de calle / farolas de pared flotando donde no hay fachada. Causa 1: la tabla etiqueta de
   ráster → manzana de `geo-buildings.mjs` se construía muestreando el centroide de cada manzana y fallaba en las
   cóncavas, dejando 507 edificios "sin manzana" dentro del área urbana; ahora cada manzana guarda su etiqueta de
   componente (`label`) y, si un edificio cae sobre calzada, se busca la manzana más cercana a 12 m. Resultado: 24.037
   edificios colocados (+285), la comisaria incluida. Causa 2: `street-details.js` montaba placas y fanales "en la
   fachada" sin comprobar que hubiera una; ahora recibe los colisionadores de los edificios y solo monta en pared
   real (placa en poste en las esquinas sin edificio).

**Próximos pasos propuestos** (por impacto): (a) alturas reales por volumen con el LiDAR del ICGC; (b) relieve real
(MDE 5 m) para la ciudad y el entorno, con puentes y túneles a su cota; (c) Masia Freixa y resto de monumentos con
fotos de referencia; (d) polígonos oficiales de barris; (e) más comercios (completar OSM o datos del Ajuntament);
(f) pasos de cebra reales en cruces sin semáforo; (g) inventarios municipales de arbolado y alumbrado.

### 2026-10-24 — Sesión 1

1. Auditoría del proyecto original (3 exploraciones en paralelo del código). Resultado: la red viaria por grafo cubre
   cualquier trazado; semáforos, pasos y prioridades estaban ligados a la retícula; `boroughs.js` y `landmarks.js`
   son 100 % Manhattan y fallan con datos vacíos; `nyc-map.js` ya funciona con polilíneas genéricas.
2. Revisión de seguridad del repositorio: no se ha detectado ninguna instrucción embebida ni *prompt injection* en el
   código ni en los datos leídos. El único script con acceso a red es `tools/overpass.sh` (curl a tres servidores de
   Overpass, con validación del JSON y renombrado atómico). Las descargas se ejecutaron tras autorización expresa.
3. Redacción de las 6 consultas Overpass y descarga de los datos (77 MB en total).
4. Medición del marco (Plaça Vella, −13,7°) y escritura de `geo-base.mjs`, `geo-roads.mjs`, `geo-features.mjs`.
5. Hallazgo: cobertura parcial de edificios en OSM (13.504 huellas, 390 con plantas) → estrategia híbrida (§2.5).
6. Pipeline completa (`geo-blocks.mjs`, `geo-buildings.mjs`, `build-geodata.mjs`): 2.320 manzanas (1.467 con marcos de
   fachada girados), 13.032 huellas colocadas en 976 manzanas (620 con cobertura ≥ 40 %), 5.167 nodos y 7.402 tramos
   del grafo. `js/terrassa-geodata.js` = 4,0 MB (NYC: 1,1 MB). Tiempo de construcción: 15 s.
7. Verificación visual de los datos (render PNG con Pillow desde el JSON generado): Riera de les Arenes, Parc de
   Vallparadís, Eixample, polígonos industriales y rondas en su sitio; cobertura de huellas: Centre 79 %, Ca n'Aurell
   77 %, Ca n'Anglada 55 %, la Maurina 50 %, Sant Llorenç 26 %, Sant Pere Nord 2 %.
8. Reescritura de `city-config.js`, `road-network.js`, `pedestrian-routes.js`, `traffic.js` (fases/pasos),
   `controllers.js`, `main.js` (unidades). Seis agentes en paralelo sobre: suelo y detalles de calle; edificios;
   monumentos; entorno regional; mapa, cámaras e interfaz; vehículos.
9. Integración: `main.js` (mapa, cámaras, entorno, nombres de grupo para el culling), `tsl-materials.js` sin Central
   Park ni orillas (oclusión de cielo y reflejos nocturnos genéricos), borrado de `nyc-geodata.js`, `boroughs.js`,
   `fire-escapes.js` y los datos de Nueva York. 115 tests en verde; comprobación estática de que todos los `import`
   con nombre resuelven. Primera carga en navegador (del propietario, la extensión de Chrome no estaba disponible en
   la sesión): dos errores corregidos — un `assign` de TSL fuera de `Fn()` en el material de carreteras del entorno y
   la función `laneOffsets` borrada por error de `road-network.js`. Primer push a `github.com/oegea/slop-egara`.

---

## 4. Tiempo de ejecución (`js/`) — plan y estado

| Módulo | Estado | Qué cambia |
|---|---|---|
| 4.1 `city-config.js` | ✅ hecho | Reescrito del todo: marco, suelo (`LAND_RING`), calles (`ROADS`, `STREET_INDEX`, `nearestRoads`), manzanas (`BLOCKS`, `blockAt`), barrios (`DISTRICTS`, `blockProfile`: tipología constructiva por barri, 🟠 tabla manual), parques/usos/rieras/vías/árboles, monumentos (`LANDMARK_SITES`, `MODELLED_LANDMARKS`, `CITY_LANDMARKS`), teletransportes calculados sobre la calle más cercana a cada monumento (`streetSpotNear`), etiqueta de posición ("Carrer de Sant Pere & Carrer de la Rutlla", "Mercat de la Independència · Rambla d'Ègara & Carrer de Volta") |
| 4.2 `road-network.js` | ✅ hecho | Sin corredores de retícula: todas las calles son aristas "generales" del grafo. Los bordillos se comprueban contra el **polígono real** de cada manzana (`blockAt`), no contra rectángulos. Semáforos: los nodos OSM `highway=traffic_signals` (🟡 236 cruces; los semáforos de media manzana se tratan como pasos). Prioridad en cruces sin semáforo: la vía más ancha / de mayor clase (🟠 OSM `stop`/`give_way` se guardan en `n.stop` pero aún no se usan). Vías mayores: clase primaria/secundaria/autopista o nombre que empieza por Avinguda, Rambla, Passeig, Carretera, Ronda, Autopista, Autovia, Via |
| 4.3 `pedestrian-routes.js` / `traffic.js` | ✅ parcial | Pasos de peatones en cruces semaforizados en **cualquier ángulo** (a lo largo del eje lateral de cada vía que llega al cruce). Fase peatonal según el grupo de prioridad de la vía que se cruza (`n.sideGroup`). ⚪ Pendiente: usar los 3.971 pasos de cebra reales (`roadGraph.crossings`) para cruces sin semáforo; fases independientes en cruces de 3+ vías (hoy todas las secundarias comparten fase y el cruce se protege con la ocupación de la caja). Vehículos: ver 4.12 |
| 4.13 Vehículos (`actor-models.js`, `traffic.js`, audio) | ✅ hecho | Ver §5.1: taxis blancos con franja roja y azul, Policia Municipal (banda ajedrezada azul/amarilla, luces solo azules) y Mossos d'Esquadra (banda azul oscura y línea roja) con **estados patrulla/emergencia** (`FEATURES.emergencyStates`, sesión 4), autobuses de TMESA con letreros L1–L9, matrículas españolas, helicóptero de rescate, sirena bitonal solo en emergencia |
| 4.12 `controllers.js` / `main.js` | ✅ hecho | Aparición en la calle más cercana a la Plaça Vella; taxi blanco con franja roja y azul (🟠 librea aproximada, número de licencia inventado), matrícula española "4821 KTR" (🔴 inventada); km/h, marcha y rpm en el HUD; estado y vehículo guardados en `terrassa-player-state`; subir/bajar (`F`), garaje (`G`), puente de luces (`L`) |
| 4.15 `vehicle-physics.js`, `parked-bikes.js` + integración en `controllers.js`, `street-details.js`, `city-grid.js`, `traffic.js`, `main.js` | ✅ hecho (sesión 4, ver §5.8) | `FEATURES.carPhysics` (modelo de cuatro ruedas), `propCollisions` (postes, bolardos, papeleras, bancos, troncos), `vehicleGarage` (seis vehículos), `enterExit` (una persona que sube y baja; bicis aparcadas), `emergencyStates` |
| 4.4 `city-grid.js` | ✅ hecho (ver §5.6) | Quitar agua, muelles, Central Park, plazas de Times Square, Battery; suelo = caja de detalle; aceras y bordillos genéricos; parques desde OSM; rieras; superficies por uso del suelo |
| 4.5 `buildings.js` | ✅ hecho (ver §5.4) | Huellas reales extruidas + generador procedural con tipologías de Terrassa; sin escaleras de incendios ni depósitos de agua; terrats con caixa d'escala |
| 4.6 `landmarks.js` | ✅ hecho (ver §5.5) | Constructor por datos (huella real + altura por tipo) con modelos específicos para los más icónicos |
| 4.7 `street-details.js` | ✅ hecho (ver §5.6) | Semáforos y señales en los cruces del grafo; placas de calle catalanas; farolas genéricas; sin bocas de metro ni carritos de perritos |
| 4.8 `nyc-map.js` → `city-map.js` | ✅ hecho (ver §5.3) | Suelo = término municipal; etiquetas de barrios; sin puentes/muelles |
| 4.9 `boroughs.js` → `surroundings.js` | ✅ hecho (ver §5.2) | Municipios vecinos como suelo de bajo detalle, polígonos de asentamiento con edificios genéricos, autopistas y ferrocarriles de la región, silueta de montañas (La Mola 1.104 m, Montcau 1.056 m, Serra de l'Obac) |
| 4.10 UI / HUD (`index.html`, `css/style.css`, `cameras.js`, README) | ✅ hecho (ver §5.3) | Nombre, unidades métricas (km/h, m), textos, iconos, fuentes |
| 4.14 `terrain.js` + integración en `city-grid.js`, `buildings.js`, `landmarks.js`, `street-details.js`, `road-paint.js`, `traffic.js`, `controllers.js`, `cameras.js`, `audio-sources.js`, `surroundings.js`, `main.js` | ✅ hecho, ⚪ datos reales pendientes (ver §2.8, §5.7) | `FEATURES.terrain`: el relieve se carga de `js/terrassa-terrain.bin` y todo lo que toca el suelo pasa por `groundHeightAt()`; sin el fichero la ciudad sigue plana |
| 4.11 Tests | ✅ hecho | `teleports`, `city-map`, `cameras`, `controllers`, `geodata`, `traffic*`, `vehicle-lights` en verde; `boot` pasa tras la integración | Actualizar `teleports.test.cjs`, `boot.test.cjs`, stubs |

---

## 5. Informes de fidelidad por módulo

### 5.1 Vehículos (`js/actor-models.js`, `js/traffic.js`, `js/audio-*.js`)

| Elemento | Marca | Detalle |
|---|---|---|
| Sentido de circulación | ✅ | Por la derecha |
| Matrículas | 🟡 | Formato español real "1234 BCD" (4 dígitos + 3 consonantes sin vocales, Ñ ni Q), fondo blanco, banda azul UE con 12 estrellas y "E". Números pseudoaleatorios deterministas (4 variantes compartidas por todos los coches). Mejora: una variante por coche vía atributo de instancia |
| Taxis | 🟡 | **Corregido con fotos (sesión 4)**: el taxi de Terrassa es **blanco liso**, con una escalera de pequeños cuadrados rojos ("píxels") arriba en la puerta delantera y abajo en la aleta trasera, el escudo de la ciudad (losange con el castillo y corona mural) y "Terrassa / TAXI nn" en negro en la puerta delantera, luminoso "TAXI" en el techo. La antigua franja diagonal roja y azul era inventada y se ha quitado. Fuentes: foto de flota en taxiterrassa.info (Tele Taxi Ègara, Tesla "TAXI 79" en l'Estació del Nord), MónTerrassa 2019/2021/2022 (fila de taxis en la Rambla, detalle "TAXI 16"). Texto real ("Terrassa" / "TAXI 16") desde un atlas de letras (`liveryTextAtlas`). Aproximado: la forma exacta de la escalera (5 cuadrados de 7 cm en el simulador), el escudo simplificado, número de licencia inventado |
| Policia Municipal | 🟡 | **Imagen corporativa 2024** (foto de La Ciutat, 29-1-2024: nueve Ford Kuga híbridos ante el Ajuntament): puertas blancas con "policia municipal" en azul, aleta delantera y trasera en amarillo fluorescente con bloque azul inclinado, ajedrezado azul/blanco por los estribos con extremos en diagonal, capó azul con "policia" blanco y borde amarillo, puente azul (apagado en patrulla). (La librea anterior de los Prius+ de 2019, puertas azules con rombos, queda sustituida.) **Trasera 🟠 extrapolada** de los lados (ajedrezado + banda azul): falta una foto de espaldas. La flota real son SUV Kuga: el simulador usa la berlina. Aproximado: sin escudo ni "112", bloques inclinados estimados |
| Mossos d'Esquadra | 🟡 | **Corregido con fotos (sesión 4)**: la imagen corporativa de 2020 (SEAT Ateca y Arona): blanco; **capó azul marino** con "policia" en blanco y un ajedrezado rojo/blanco en su borde delantero; **banda azul marino bajo las ventanillas** de la aleta delantera a la cola, cortada por **dos bloques blancos inclinados con una franja roja** (pilar B y aleta trasera), "policia" pequeño en blanco sobre la aleta; **"mossos d'esquadra" en azul** a lo largo de las dos puertas; **banda ajedrezada rojo/blanco por los estribos**; puente de luces azul. Fuentes: Wikimedia Commons "Seat Ateca dels Mossos 01-03" y "SEAT Arona - Mossos d'Esquadra"; Cugat Mèdia (5 Ateca, 2025); Ara.cat y El Motor de Girona (2020, descripción de la nueva imagen). Texto real ("mossos d'esquadra" en azul, "policia" en la aleta y en el capó leído desde delante, "www.mossos.cat" en la banda del portón) desde el atlas de letras; **trasera** con banda azul marino y ajedrezado rojo/blanco bajo (fotos: León CME 9347, Kuga). Aproximado: sin el escudo de la Generalitat, sin el "policia" de la luna trasera ni el "112" de la ventanilla, sin el número de techo |
| Estados de la policía | 🟡 | Patrulla por defecto (sin luces ni sirena, respeta semáforos). Las emergencias no arrancan solas (decisión del propietario): `__slop.traffic.startEmergency()` manda a la patrulla más cercana a una de 40–90 s (luces, sirena, se salta semáforos con cautela). Pendiente: que el tráfico se aparte, estado "parado con luces", ambulancias SEM |
| Proporción de flota | 🔴 | 1 taxi cada 9 coches y 1 policía cada 60 son decisiones de diseño. Paleta de turismos (blanco/plata/gris mayoritarios) aproximada a la matriculación española |
| Autobuses TMESA | 🟠 | Carrocería de 12 m de piso bajo (reutiliza la geometría del bus de 40 ft). Librea blanca con banda granate y cinta gris: aproximación de memoria, no la librea oficial. Mejora: fotos de la flota actual (tmesa.cat) para corregir tonos y forma de la banda |
| Letreros de línea | 🟠/🔴 | L1–L6, L8, L9 son líneas de TMESA; los destinos ("Can Roca · Centre", "Ca n'Anglada", "Sant Llorenç", "Can Palet", "Les Fonts", "Can Jofresa", "Ca n'Aurell", "Hospital") son inventados plausibles. Mejora: lista real de líneas y terminales de tmesa.cat en `BUS_ROUTES` de `traffic.js` |
| Helicóptero | 🔴 | Librea de rescate rojo/amarillo/blanco inspirada en los helicópteros de Bombers de la Generalitat; no reproduce ninguna aeronave real |
| Ambulancias SEM | ⚪ | No implementadas |
| Sirena | 🟠 | Cuatro tonos sintetizados, **afinables en caliente** desde la consola (`__slop.sirenTuning`): bitonal 700/930 Hz a 0,8 Hz con glissando de 40 ms, wail 520→1450 Hz a 0,25 Hz, yelp 3,3 Hz, phaser 10 Hz, bocina brillante (paso-bajo 7 kHz). `K` los recorre (independiente de `L`); el tráfico solo en emergencia (Mossos wail, Policia Municipal bitonal). Sin grabación de referencia (el propietario no tiene ninguna) y sin fuente documental catalana: los valores finales los fija el propietario de oído y se consolidan en `SIREN_TUNING`; falta el "air horn" |
| Luces de emergencia | 🟡 | Solo azules (correcto en España). Puente de **8 módulos** con cuatro modos, por instancia (`barLit`): posició fija; prioritari 1 Hz, doble destello de 90 ms por mitad; emergència 1,25 Hz, ráfagas triples de 60/60 ms exteriores→interiores (sin nada superpuesto); escombrat, un módulo ida y vuelta en 1,2 s. Tiempos medidos por test (`tests/lightbar.test.cjs`), compartidos con las luces puntuales del jugador. Cadencias plausibles de los puentes LED, no medidas sobre ninguno real; sin luces de calandra ni de retrovisor; sin luces traseras de emergencia |
| Sonido guardado | — | Clave `localStorage` `'terrassa-sound'` (antes `'nyc-sound'`) |
| Tráfico de autopista | ⚪ | `createHighwayTraffic` se mantiene sin carriles (main.js pasa `[]`); reutilizable para la C-58/B-40 cuando se modelen a su cota |

### 5.2 Entorno regional (`js/surroundings.js`, sustituye a `boroughs.js`)

| Elemento | Fidelidad | Detalle |
|---|---|---|
| Cimas (220 nodos `natural=peak` con nombre y cota a < 16 km: la Mola 1.103, el Montcau 1.056, Castellsapera 939, Turó de l'Ós 672...) | ✅ posición y cota exactas | Las 9 cimas dentro de la caja de detalle (Turonet del Palau, Montagut...) se ignoran: la ciudad queda plana |
| Polígonos de asentamiento (342: 172 residenciales 79,5 km², 148 industriales 28,4 km², 16 comerciales, 6 retail) | ✅ contorno exacto (simplificado a 6 m) | Pintados en el suelo con una textura de 1024² (39 m/px) y usados para situar los edificios |
| Poblaciones (20 nodos `place` con población) | ✅ | Escalan densidad y altura de los edificios genéricos |
| Autopistas y carreteras (3.936 tramos: C-58, B-40, C-16, AP-7, A-2, N-150, C-1413a, BP-1503...) | ✅ trazado · 🟡 ancho (24 m autopista, 9 m resto) · 🟠 cota (siguen el terreno procedural; túneles excluidos) | Los tramos dentro de la caja los dibuja `city-grid.js` |
| Ferrocarriles (461 tramos: R4 Barcelona–Manresa, FGC Barcelona–Vallès métrico, LAV, Castellbisbal–Mollet) | ✅ trazado · 🟡 ancho de balasto y galga | Ídem |
| **Relieve** (Sant Llorenç del Munt i l'Obac, Collserola, valle del Llobregat) | 🟠 **aproximado: no es un MDE** | Campo de alturas procedural: conos suaves alrededor de cada cima, radio ∝ altura relativa (3,4 m por m), + base del macizo al norte + ruido; plano en la caja de detalle y 1,5 km alrededor. Resultado: la Mola +892 m sobre la ciudad (real +823), Montcau +811 (real +776) |
| Color del terreno (pino blanco y encina, roca conglomerada ocre-gris en las cingleres, campos del Vallès) | 🔴 | Por altura, pendiente y ruido; no hay `landuse=forest` en la consulta regional |
| Edificios genéricos de los pueblos (43.444 cajas instanciadas: 2–8 plantas, torres de 9–15 en Sabadell, naves industriales, chalets en Matadepera/Ullastrell/Vacarisses) | 🔴 | Rejilla de solares por polígono con jitter; paleta catalana (revoco, ladrillo, teja, terrats); ventanas iluminadas de noche |
| Bosque lejano (50.000 pinos/encinas instanciados) | 🔴 | Posiciones y especies procedurales según altura/pendiente |

**Cómo mejorarlo:**
1. **Relieve real:** ✅ dentro de la caja de detalle y 400 m alrededor (§2.8); fuera, el modelo procedural se suma a la cota del borde (`terrainModel()` en `surroundings.js` lee `terrainY()`). Mejora: ampliar el MDE (el WCS del ICGC sirve 5 m en toda Catalunya) a los 20 km del retículo regional y sustituir del todo los conos procedurales.
2. **Edificios reales de Sabadell, Rubí, Sant Quirze, Matadepera...:** ampliar `q_region.overpassql` con `way["building"]` a < 10 km (o el Catastro INSPIRE de cada municipio) y extruirlos con la misma caja instanciada.
3. **Cobertura forestal real:** añadir `landuse=forest`, `natural=wood/scrub`, `landuse=farmland/orchard/vineyard` a la consulta regional y pintarlos en la textura de usos para colorear el terreno y sembrar los árboles sobre bosque real.
4. **Carreteras:** elevar puentes y viaductos (`bridge=yes`) sobre el terreno; añadir señalización y farolas de autopista.
5. **Luz nocturna de los pueblos:** usar la trama viaria real (`highway=residential` regional) en lugar de la rejilla de 30 m del shader.

### 5.3 Mapa, cámaras e interfaz (`js/city-map.js`, `js/cameras.js`, `index.html`, `css/style.css`)

**Mapa (`city-map.js`)**
- ✅ Exacto (datos OSM vía city-config): contorno del área de detalle, límite municipal de Terrassa (discontinuo) y los 30 municipios vecinos con su nombre al alejar; las 2.320 manzanas reales coloreadas por uso del suelo; contornos y nombres de los 180 parques/plazas; rieras y torrents con su ancho real; vías férreas a cielo abierto; 4.687 ejes de calle con jerarquía por clase (autopistas/rondes naranja, primarias/secundarias/avingudes amarillo pálido, calles finas, peatonales punteadas); huellas de los 30 monumentos modelados y marcas de los 17 lugares destacados; 51 nombres de barri a zoom medio y 17 plazas a zoom alto; rótulos de calle a lo largo de su trazado (1.183 nombres en catalán completo); búsqueda sobre calles, monumentos, parques y barris.
- 🟡 Derivado: posición de los rótulos de barri = nodo `place=neighbourhood` de OSM (no el centroide del polígono oficial); capa de usos naturales (bosque/campo/agua) como fondo bajo las manzanas.
- 🔴 Inventado: paleta (atlas oscuro, manzanas "papel cálido", ruta GPS en rojo); ruta GPS en línea recta (el original seguía la retícula); el plano se dibuja con el norte de la retícula arriba (13,7° al oeste del norte real; la brújula lo indica). Eliminado: costa, muelles, boroughs, puentes, Central Park, Times Square como destino inicial (ahora Plaça Vella).
- **Mejoras:** (a) polígonos oficiales de barris/districtes de `opendata.terrassa.cat`; (b) ruta GPS por el grafo (`GEO.roadGraph`, Dijkstra); (c) nombres de rieras a lo largo de su curso; (d) sombreado de relieve (MDE ICGC) como fondo del Vallès; (e) vista "norte real arriba" opcional rotando el lienzo −13,7°.

**Cámaras (`cameras.js`)**
- 🟡 Los 7 puntos de vista escénicos (`placaVella`, `masiaFreixa`, `rambla`, `vallparadis`, `mutua` a 70 m de altura, `estadi`, `skyline` hacia La Mola, más `drone`) se calculan en carga a partir de los centros y huellas reales de los monumentos; las distancias y alturas son 🔴 elección estética.
- **Mejora:** elevar cada cámara con la cota real cuando haya terreno; añadir cámaras de la Seu d'Ègara y la Torre del Palau.

**UI / HUD**
- 🔴 Inventado: insignia redonda roja `#c8102e` con "T" blanca (no es el escudo oficial de Terrassa, que es un escudo con torre y la senyera; usarlo requeriría comprobar su licencia/uso); acento rojo en vez del amarillo taxi; placas de calle estilo catalán (fondo crema `#f3eee2`, letra y borde azul `#1e3a70`) — aproximación genérica, las placas reales de Terrassa son de cerámica/esmalte con tipografía variada. UI en inglés (como el original) con topónimos en catalán sin abreviar; unidades métricas (km/h, m).
- 🟡 Subtítulos de los destinos de teletransporte (barri · calle) escritos a mano a partir de `CITY_LANDMARKS[].district` y de la calle preferida en city-config.
- **Mejora:** generar la lista de destinos y cámaras desde city-config en vez de HTML estático; versión en catalán de la UI (`lang="ca"`) como opción.

**Nombre público:** el README (en catalán, tono memístico) se titula *Grand Theft Ègara* (Ègara = nombre antiguo de Terrassa + guiño a GTA); "Frankfurt City" queda como chiste interno. El nombre interno de la app es *Slop Terrassa*.

**Tests (`tests/`)**
- `teleports.test.cjs` carga el city-config real: cada destino tiene botón, ninguno cae en manzana, todos en tierra, a ≤ 6 m de una calle. `city-map.test.cjs` y `cameras.test.cjs` con stubs de Terrassa. `geodata.test.mjs` construye los datos reales (15 s).

### 5.4 Edificios (`js/buildings.js`) — con Catastro (sesión 2)

Un único camino por manzana: **A, edificios reales** (1.543 manzanas con Catastro u OSM: 25.463 edificios, 110.265 volúmenes → 112.466 cajas) y **B, procedural** solo en las 207 manzanas edificables sin ningún edificio.

| Elemento | Marca | Detalle |
|---|---|---|
| Huella de cada volumen (Catastro, cajas en el marco del edificio, error ≤ 0,25 m) | ✅ Exacto | se omiten los edificios cuyo centroide cae en un recinto de `MODELLED_LANDMARKS` |
| Plantas de cada volumen (cuerpo, ático, cuerpo trasero, patio = plinto de 0,6 m) | ✅ Exacto | `numberOfFloorsAboveGround` por parte; solo las 1.711 huellas OSM sin `building:levels` usan las plantas típicas del barri |
| Uso (residencial / agrario / industrial / oficinas / comercio / equipamiento) y año de construcción | ✅ Exacto | eligen tipología, cubo de fachada, altura de planta, comercio en planta baja y ornamento |
| Metros por planta (3,1 residencial, 3,4 pre-1940, 3,6/4,0 planta baja comercial, 4,2 vapors y comercio, 6,5 naves, 3,5 oficinas, 3,8 equipamiento) | 🟡 Derivado | el Catastro no da metros. Mejora: LiDAR ICGC |
| Medianera / fachada a calle / patio por sondeo geométrico (volúmenes del mismo edificio y vecinos a ≤ 1,5 m; acera y calzada a ≤ 9 m) | 🟡 Derivado | depende del ancho de acera modelado (2,4 m) |
| Rótulos y toldos con el nombre real de 547 comercios de OSM en la pared a calle más próxima (≤ 14 m, 20 m en segunda pasada) | ✅ nombre exacto, 🟡 portal aproximado | los 217 restantes (gasolineras, grandes superficies, masies) quedan sin rótulo; ningún edificio sin comercio en OSM lleva rótulo |
| Materiales y colores por época y uso (8 cubos: estuco ocre y rosado pre-1940, ladrillo de vapor, estuco liso 1940-60, bloques 1960-85, moderno beige/blanco, paneles de nave, muro cortina) | 🟠 Aproximado | la época es real, el material concreto es inventado |
| Cubiertas: `roof:shape` de OSM cuando existe; si no, teja al 60 % en casas pre-1940 ≤ 2 plantas, dents de serra en naves pre-1960, terrat con caixa d'escala en el resto | 🔴 Inventado (salvo OSM) | el Catastro no da forma de cubierta |
| Cornisas, balcones (85 % pre-1940, 60 % bloques), caixes d'escala, climatizadores | 🔴 Inventado | porcentajes plausibles por época |
| Edificios procedurales en las 207 manzanas vacías | 🔴 Inventado | mismo generador que antes, nunca mezclado con huellas reales |

**Cómo mejorar:** alturas reales con LiDAR ICGC (MDS−MDT por volumen); cubiertas desde la ortofoto de 25 cm del ICGC o `roof:shape` en OSM; colocar los 217 comercios restantes buscando también paredes a patio/aparcamiento; completar los comercios de OSM (Terrassa tiene miles y OSM solo 868); fusionar volúmenes contiguos de igual altura para reducir los 112.466 colisionadores a la mitad; el atlas de rótulos es una textura de 4096×2304 (37 MB).

### 5.5 Monumentos (`js/landmarks.js`)

Constructor por datos: cada nombre de `MODELLED_LANDMARKS` se levanta sobre su **contorno real de OSM**; 31 sitios, 34.651 triángulos, 188 cajas de colisión. Convención: **Huella** = contorno OSM extruido tal cual (✅); **Altura** = OSM (✅) o supuesta (🟠); **Forma** = modelo específico (🟡 aproximación low-poly) o extrusión genérica (🟠).

| Monumento | Huella | Altura | Forma | Cómo mejorar |
|---|---|---|---|---|
| Catedral del Sant Esperit | ✅ (2.438 m²) | 🟠 nave 15 m + cubierta a dos aguas hasta 20,5; cimborio 27; campanario 44 + aguja a 56 | 🟡 contrafuertes y lancetas, rosetón y portal hacia la Plaça Vella, linterna octogonal, torre en la esquina NO con chapitel | Altura real del campanar y de la nave (ICGC LiDAR/3D) |
| Masia Freixa | ✅ (721 m²) | 🟠 galería 4,6 m, azotea 8,2, torre 24 m | 🟡 arcadas parabólicas caladas, ventanas parabólicas, 5 cúpulas nervadas blancas, torre-minarete, banda cerámica verde | Planos de Muncunill para número y posición exactos de cúpulas |
| Torre del Palau | ✅ (39 m²) | ✅ OSM 26,7 m | 🟡 torre cuadrada de piedra almenada | — |
| Castell Cartoixa de Vallparadís | ✅ (818 m²) | 🟠 muros 12 m, torres 18–21 | 🟡 almenas, 4 torres en las esquinas, tejado interior | Alturas reales; claustro no modelado |
| Mercat de la Independència | ✅ (3.046 m²) | 🟠 9,5 m + nave central 13,5 | 🟡 pilastras y grandes arcos de ladrillo, claristorio, frontispicio de piedra | La huella OSM parece incluir anexos: revisar en Catastro |
| Ajuntament / Antic Ajuntament | ✅ | 🟠 13,6 m | 🟡 civil + balcón, banderas, frontón con reloj hacia el Raval | Alturas reales |
| Vapor Aymerich, Amat i Jover (mNACTEC) | ✅ (15.973 m², bajo el nombre del museo) | 🟠 nave 8 m, dents de serra +2,6 cada 6 m, chimenea 42 m | 🟡 ladrillo con pilastras y arcos, cubierta en dientes de sierra recortada al contorno real, chimenea en la esquina NE | Paso real de los dientes y posición exacta de la chimenea (ICGC 3D) |
| Teatre Principal | ✅ | 🟠 14,4 m + caja escénica 26 m | 🟡 modernista + torre escénica | Altura real de la caja escénica |
| Santa Maria / Sant Pere / Sant Miquel (Seu d'Ègara) | ✅ | 🟠 9 / 8 / 7 m; campanar 17, linterna 14 | 🟡 arenisca; cimborio y campanario, espadaña, linterna octogonal | Alturas medidas; ábsides no modelados |
| Hospital Mútua de Terrassa | ✅ (1.773 m²) | ✅ OSM 70 m, 17 plantas | 🟡 extrusión con fachada propia, entrada acristalada, cuarto de máquinas | Fachada real (muro cortina parcial) |
| Estadi Municipal Olímpic | 🟡 envolvente convexa del contorno | 🟠 graderío 11,4 m, cubierta 17,5, torres de luz 32 | 🟡 gradas escalonadas, cubierta sobre una tribuna, 4 torres, césped | Lado real de la tribuna cubierta; superficie azul de hockey |
| Estació del Nord / Terrassa Est | ✅ | 🟠 9 m (OSM `height=3.2` ignorado) | 🟡 ladrillo + tejado + marquesina de andén | Lado real de los andenes |
| Casa Alegre de Sagrera, Museu Tèxtil, Institut Industrial, Casa Baumann | ✅ | 🟠 13–16,5 m | 🟠 genérico con doble cornisa, balcón, portales (Baumann: torreón) | Alturas y estilo de fachada |
| Hospital de Terrassa | ✅ (13.431 m²) | 🟠 22 m | 🟠 genérico hospitalario | Complejo de varios bloques: Catastro/ICGC |
| Chimeneas (9) | ✅ | ✅ OSM (Bòvila Almirall 63 m, 42, 45, 45, 25, 20, 20, 10); 🟠 Cal Guardiola 30 m | 🟡 fuste troncocónico, zócalo y corona | Altura de Cal Guardiola |
| Carrilló del mNACTEC | ✅ punto | 🟠 26 m | 🟡 fuste de ladrillo + campanario abierto con 5 campanas | Fotos de la estructura real |

Pendiente general: todas las alturas 🟠 pueden sustituirse por el modelo 3D de edificios / LiDAR del ICGC; las cubiertas siguen el contorno real pero con pendientes supuestas. `'Gran Casino'` no tiene huella en OSM (hay un constructor genérico listo si aparece).

### 5.6 Suelo, parques y detalles de calle (`js/city-grid.js`, `js/street-details.js`)

| Elemento | Fidelidad | Detalle / cómo mejorarlo |
|---|---|---|
| Suelo de asfalto | 🟡 | Un solo plano a cota 0 sobre la caja de detalle; sin relieve. Mejora: MDE 5 m del ICGC y pasar la ciudad a terreno real (`groundHeightAt` de city-grid es el punto de enganche) |
| Contorno de aceras y bordillos | 🟡 | Islas de bordillo derivadas del eje OSM + ancho de calzada modelado (§2.2); altura de bordillo 0,15 m y acera de 2,4 m constantes 🟠. Mejora: calzadas y aceras del ICGC 1:5.000 |
| Medianas (Rambla d'Ègara, avenidas) | 🟡 | Geometría derivada; seto 🔴 en medianas de 2,2–3,4 m, plátanos cada 8 m 🔴 en las de ≥ 3 m. Mejora: inventario de arbolado municipal |
| Parques (113 manzanas) | contorno ✅ / interior 🔴 | Césped, caminos de sauló en estrella hacia el centroide, bancos cada 9 m, farolas cada 24–34 m, árboles en rejilla de 11–13 m. Mejora: caminos reales (`highway=footway` dentro de parques, no descargados) y plano de cada parque |
| Parc de Vallparadís | contorno ✅ / cota 🔴 | Hundido 2,4–3,2 m con taludes de 4–12 m; en realidad el fondo del torrent queda 8–15 m bajo algunas calles y los puentes (Pont de Sant Pere, Passeig del Vint-i-dos de Juliol) lo cruzan. Mejora: MDE del ICGC + puentes como viaductos |
| Plazas (24 manzanas) | contorno ✅ / mobiliario 🔴 | Pavimento de granito, árboles en alcorque cada 9 m, bancos, farolas. La Plaça Vella real no tiene árboles en rejilla: afinar plaza a plaza |
| Bosques (36 manzanas, 1.590 ha) | polígono ✅ / arbolado 🔴 | Árboles cada 21 m (36.000) con esqueletos aproximados (pino carrasco ≈ acacia, encina ≈ olmo). Mejora: especies mediterráneas en trees.js, densidad del LiDAR / Mapa Forestal |
| Matorral y cultivos | polígono ✅ / superficie 🔴 | Textura de ruido ocre; surcos alineados con la retícula |
| Deportivo (10) | polígono ✅ / superficie 🔴 | Césped con rayas, valla de 3 m con dos puertas: sin pistas ni gradas |
| Aparcamientos (12) | ✅ / farolas 🔴 | Anillo de acera, asfalto, farolas cada 26 m; sin plazas pintadas |
| Cementiri de Terrassa | contorno ✅ / interior 🔴 | Muro de 2,4 m con una puerta 🟠, pavimento y cipreses en rejilla de 9 m; nichos ⚪ |
| Ferrocarril (19 km) | trazado ✅ / vía 🔴 | Balasto 7 m, carriles a 1,435 m: **Renfe R4 es ancho ibérico (1,668 m)**, FGC métrico (1,000 m) — corregir. Puentes ferroviarios a cota de calle |
| Riera de les Arenes y Riera del Palau | trazado ✅ / ancho 🟠 / canal 🔴 | Canal hundido 2,4 m (Arenes) / 1,6 m con parapeto de 1 m y paseo arbolado; el canal real de la Riera de les Arenes tiene ~30 m y 4–5 m de profundidad con taludes de hormigón. Mejora: MDE + sección real |
| Torrents (135 km) | trazado ✅ / cauce 🟡 | El valle lo da el relieve (§2.8); encima, una franja de tierra y lodo; tramos bajo calle omitidos |
| Semáforos (236 cruces) | nodo ✅ / poste 🟡 / aspecto y fases 🔴 | Poste en la esquina derecha de cada acceso, 430 cabezas, báculo en calzadas ≥ 11 m; ciclo único de 60 s. Mejora: inventario de semáforos y planes de fases del Ajuntament |
| Semáforos peatonales | pasos ✅ / colocación 🟡 | 797 cabezas en los 571 pasos semaforizados de OSM; fase deducida de la vía principal del cruce |
| Placas de calle | nombres ✅ / posición 🟡 / diseño 🟠 | Solo sobre fachada real (se comprueba contra los colisionadores de los edificios y la placa se desliza hasta 6 m por la fachada hasta encontrar pared): 4.803 en fachada; en esquinas sin edificio (solares, aparcamientos, bloques abiertos) las dos placas cuelgan de un poste azul de 2,6 m a 0,4 m del bordillo 🟠 (7.004 en 4.092 postes); ninguna en parques y campos |
| Farolas de pared | posición 🔴 / montaje 🟡 | Solo con muro ≥ 2,5 m a menos de 1 m detrás (1.053); si no, báculo de 4,6 m en el bordillo (3.161 convertidas) o nada si no hay acera |
| Farolas | posición 🔴 / tipología 🟠 | Columna de 8 m cada 28 m (calzada ≥ 8 m), báculo de 4,6 m cada 24 m, fanal de pared cada 20 m en casco antiguo y peatonales. Mejora: inventario de alumbrado público (opendata.terrassa.cat) |
| Árboles viarios | 834 ✅ (753 colocados) / alineaciones 🔴 | Plátanos cada 7–8 m en calles ≥ 9 m, ornamentales en el 30 % de calles residenciales. Mejora: inventari d'arbrat viari del Ajuntament |
| Papeleras, bolardos, bancos | 🔴 | Papelera junto a semáforos y 30 % de farolas; bolardos cada 2,5 m en peatonales; bancos tipo Neobarcino en parques y plazas |
| Mobiliario eliminado | — | Sin bocas de metro, carritos, hidrantes, buzones, chimeneas de vapor ni barreras de Nueva York |

### 5.7 Relieve (`js/terrain.js` y módulos integrados)

| Elemento | Fidelidad | Detalle |
|---|---|---|
| Alturas del terreno | ✅ MDT ICGC 5 m → 10 m | §2.8; el fichero generado (`js/terrassa-terrain.bin`) va en el repositorio, el ASC de 96 MB no |
| Deck de asfalto | 🟡 | Malla de la retícula del relieve (10 m) en losetas de 500 m, faldón perimetral de 30 m; frustum culling por loseta |
| Aceras, bordillos, parques | 🟡 | Drapeado exacto sobre la retícula (`latticeCapGeometry`, `refineGeometry`); bordillo = muro exterior + tira de 0,25 m; patios de manzana con 2,5 m de canto |
| Vallparadís y rieras | 🟠 | Con relieve, las excavaciones sintéticas de `city-grid.js` (parques hundidos, canales) se desactivan: el valle lo da el modelo; los canales de hormigón de las rieras quedan para cuando haya datos (son lechos planos sobre el terreno) |
| Calles | 🟡 | Cotas por cruce + perfil suavizado con limitador de pendiente (§2.8); puentes como tableros rectos con asfalto, aceras y pretiles (sin pilas ni arcos 🟠); pasos superiores sin etiqueta como rampas 🟠; túneles excluidos ⚪ |
| Manzanas edificadas | 🟡 | Membrana desde el bordillo (≤ 260 m) + plataforma bajo el interior de cada edificio; cada volumen en la cota de su fachada a la calle, zócalo ciego hasta el terreno más bajo, escalonado en fachadas largas (§3 sesión 3, puntos 7–9) |
| Monumentos | 🟡 | Percentil 90 de su contorno (`Sink.base`) con zócalo de hormigón; las hileras de ventanas de los materiales "world-space" se desplazan con la cota (pendiente: atributo de base como en `buildings.js`) |
| Vehículos y peatones | 🟡 | Cota y cabeceo según la pendiente bajo cada eje, tablero de puente cuando su arista es un puente; el coche del jugador cabecea/balancea con el gradiente y se queda en su nivel al pasar bajo un puente (`hint`); sin gravedad en pendiente aún (§2.1.2) |
| Cámara y audio | ✅ | Todas las alturas son sobre el suelo (`groundHeightAt`/`terrainY`), no cotas absolutas |
| Entorno regional | 🟠 | Dentro de la caja, el real; fuera, la cota del borde + montañas procedurales; celdas de 100 m bajo el deck no se dibujan; puede verse un escalón en el límite de la caja |

### 5.8 Conducción, colisiones y simulación (`js/vehicle-physics.js`, `js/controllers.js`, `js/parked-bikes.js`)

| Elemento | Marca | Detalle |
|---|---|---|
| Modelo de conducción | 🟡 | Cuatro ruedas con muelle-amortiguador independiente, transferencia de carga, neumáticos Pacejka simplificados con círculo de fricción, ABS/TCS, freno de mano, par + cambio automático, gravedad en pendiente (sesión 4). Las cifras (masa, par, relaciones, μ, rigideces) son **plausibles por clase**, no medidas de ningún coche real; sin inercia de rueda (el patinaje es un estado, no una dinámica), sin Ackermann, sin asfalto mojado (`env.grip` existe pero siempre vale 1) |
| Vehículos del catálogo | 🟠 | Seis arquetipos sin marca: taxi (berlina híbrida), compacte, SUV familiar, Policia Municipal, Mossos d'Esquadra, esportiu. Carrocerías = los dos lofts existentes (berlina/SUV); un monovolumen, una furgoneta o un híbrido con su silueta real necesitarían lofts nuevos |
| Controles | ✅ | W acelera, S frena / marcha atrás manteniendo parado, A/D, Shift freno de mano, F subir/bajar, G cambiar coche, L puente de luces, B bocina; mando y táctil heredan (la etiqueta del botón turbo pasa a "Handbrake" en coche) |
| Colisiones con props | 🟡 | Cilindros para postes, semáforos, bolardos, papeleras y troncos; cajas orientadas para bancos. Marquesinas, señales verticales de tráfico, terrazas de bar, contenedores y setos no existen como props (no hay colisión porque no hay objeto). Sin props rompibles. Sin comprobación de altura respecto a los tableros de puente |
| Bordillos | ⚪ | El coche sigue usando `roadHeightAt` (nunca "sube" el bordillo visualmente aunque pise la acera); los bordillos no frenan ni sacuden. Pendiente §2.1.1 de `NEXT_STEPS.md` |
| Subir y bajar | 🟡 | Sin animación de puerta ni de montar; el peatón aparece junto a la puerta izquierda y el ciclista a la izquierda de la bici; la bici tomada no vuelve nunca al soporte |
| Bicis aparcadas | 🟠 | Soportes de U invertida (el modelo habitual en Terrassa) y bicis **procedurales** alrededor de plazas, monumentos/estación y bares: no hay inventario real (OSM `amenity=bicycle_parking` no está en los datos descargados; pediría permiso de red). Geometría de la bici = la del jugador |
| Sonido del motor | ⚪ | El audio sigue derivando la carga del motor de las teclas (`driveLoad`), no de las rpm ni la marcha del modelo; sin chirrido de neumáticos (`state.skid` ya se calcula) |
