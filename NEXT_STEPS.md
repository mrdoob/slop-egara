# Grand Theft Ègara — Próximos pasos

Hoja de ruta razonada para seguir mejorando el simulador **sin romper lo que ya funciona**. Complementa a
`HOW_TO_IMPROVE.md` (que registra lo hecho y la fidelidad de cada capa); aquí se recoge lo que falta, por qué, cómo
hacerlo, qué puede romperse y cómo comprobar que no se ha roto. Fecha: 2026-10-24.

Principios de trabajo para no romper nada:

1. **Cada mejora es un commit aislado con un conmutador.** Lo nuevo entra detrás de una constante de configuración
   (`FEATURES` en `city-config.js`) o de un dato opcional en `GEO` (si falta, el código sigue como hoy). Así se puede
   desactivar en segundos si algo sale mal.
2. **Datos antes que código.** Casi todo lo que aún es "inventado" lo es por falta de datos (ver tablas de
   `HOW_TO_IMPROVE.md`). Primero se consigue el dato, se mete en `tools/`, se regenera `terrassa-geodata.js` y solo
   entonces se toca el runtime.
3. **Verificación en cuatro niveles**: (a) `node --test 'tests/**/*.test.*'` (133 pruebas); (b) la prueba de humo
   headless `node tools/browser-smoke.mjs` (Chrome por DevTools Protocol: espera el `[init]`, teletransporta, captura
   pantallas y evalúa métricas sobre toda la ciudad: volúmenes enterrados, props flotantes, vértices por material);
   (c) el informe procedimental de `tools/geo-terrain.mjs` para todo lo que toque el relieve (pendientes, escalones,
   crestas, montículos de acera); (d) recarga en el navegador con la consola abierta y un recorrido fijo de prueba
   (Plaça Vella → Rambla → Vallparadís → Mútua) comparando FPS y errores.
4. **Comparar contra la realidad con capturas.** Para cada monumento o calle que se mejore, guardar una captura
   "antes/después" en `docs/` junto a la foto de referencia.

---

## Eje 1 · Realismo del mapa

### 1.1 Relieve real — ✅ hecho (2026-10-25, fusionado en `main`, conmutador `FEATURES.terrain`)

**Hecho.** Modelo de elevaciones de 5 m del ICGC (WCS, archivado comprimido en `tools/data/dem/`) → `tools/geo-terrain.mjs`
→ `js/terrassa-terrain.bin` (celdas de 10 m, centímetros sobre la Plaça Vella, tabla de puentes). La herramienta
acondiciona el modelo para una ciudad: cotas por cruce, perfil de cada calle con limitador de pendiente y aplanado de
crestas, tableros de puente, membrana por manzana desde su bordillo, plataformas bajo los edificios de ladera, informe
procedimental. En el runtime `groundHeightAt(x, z, hint)` es el único punto de verdad (con nivel de puente): asfalto,
aceras y bordillos drapeados sobre la retícula del relieve; cada volumen de edificio en la cota de su fachada con zócalo
y escalonado; tráfico, peatones, jugador, cámara y audio sobre el suelo. Detalle y fidelidad: `HOW_TO_IMPROVE.md` §2.8,
§3 (sesión 3), §5.7; decisiones: `VDR/0012`, `0020`–`0027`.

**Lo que queda (por orden de impacto).**
1. **Pasos superiores sin etiqueta `bridge`** (nudos de la C-58, N-150, enlaces de autopista: 612 de las 1.232
   crestas cortas del informe): detectar cruces de calzadas sin nodo común y tratar la superior como tablero
   (hoy la inferior baja y sube en rampa al 18 %). Riesgo bajo: todo en la herramienta. **Es donde están las
   "crestas a lo largo del asfalto" que ve el propietario** (sesión 4, ronda 5: Rambleta del Pare Alegre / Av. de
   Joaquim de Sagrera bajo la N-150, Ronda de Ponent en trinchera, Av. de Santa Eulàlia); la auditoría de calles
   ordinarias lejos de estos nudos no encuentra coronas > 0,3 m. También: **estribo a menos de una celda (10 m) de un
   paso inferior** (Ctra. de Terrassa sobre la Av. del Vallès): las dos calzadas gemelas quedan 1,2 m desfasadas; o
   celda de 5 m, o alargar el tablero hasta el estribo real.
2. **Túneles** (`tunnel=yes`, hoy excluidos del grafo): recuperarlos como pasos inferiores con su propia cota (la
   Rambla bajo la Plaça de Catalunya, la C-58). Requiere que `groundHeightAt` sepa de más de dos niveles o que el
   túnel sea una arista con cota propia como los puentes.
3. ~~Pilas y estribos~~ ✅ (sesión 4: pilas, muros, prolongación de extremos al suelo, `VDR-0036`); quedan **arcos**
   y la forma real del Pont de Sant Pere y del Passeig (fotos), y, en la herramienta, las **cotas de los nudos de
   solo-puente del nudo C-58/B-40** (ramales de 15 m con 3–4 m de desnivel que se cruzan a cotas incoherentes).
4. **Gravedad en pendiente** para el coche y la bici (§2.1.2): hoy solo cabecean y balancean con la superficie.
5. **Base por instancia** en los materiales de fachada "world-space" de los monumentos (las hileras de ventanas se
   desplazan con la cota; en `buildings.js` ya está resuelto con el atributo `base`).
6. **MDE LiDAR de 2 m** del ICGC (solo por WMS o descarga interactiva) y, con él, celdas de 5 m donde la malla de 10 m
   no separa la acera del interior de la manzana (calles de 6 m del casco antiguo).
7. Ampliar el relieve real a los 20 km del entorno regional (`surroundings.js` aún suma conos procedurales fuera de la
   caja de detalle).

### 1.2 Alturas reales de los edificios (LiDAR)

**Qué.** Las plantas del Catastro son exactas, pero los metros por planta son una tabla. El LiDAR del ICGC (nube de
puntos 2 m, o el MDS ya rasterizado) da la altura real de cada volumen, incluida la forma de cubierta.

**Cómo.** En `tools/geo-buildings.mjs`, para cada rectángulo del Catastro, muestrear el MDS−MDT dentro de la huella
(mediana) → `height` real; si la desviación típica dentro de la huella es alta, cubierta inclinada (estimar orientación
de la cumbrera por el gradiente). El runtime ya respeta `height` cuando es > 0 (prioridad sobre plantas).

**Riesgo.** Bajo: es un dato opcional por volumen.

### 1.3 Cubiertas y materiales desde la ortofoto

**Qué.** Teja vs terrat, color dominante de cada cubierta, y con menos fiabilidad el color de fachada.

**Cómo.** Ortofoto 25 cm del ICGC (WMS). Por huella: color medio de la cubierta → terracota = teja (inclinada),
gris = terrat/gravilla, blanco = terrat pintado, metálico = nave. Se escribe en el dato del edificio (`roof`,
`roofTint`) y `buildings.js` ya tiene los tres caminos de cubierta. Para fachadas, muestrear la ortofoto oblicua no es
viable; mejor una tabla por época y barrio revisada a mano con Street View (manual, pero el Centre y la Rambla son
pocas calles).

### 1.4 Barrios oficiales y nombres

Polígonos de barris i districtes del portal `opendata.terrassa.cat` → sustituye el Voronoi de nodos de OSM
(§2.6 del diario). Mejora etiquetas del mapa, tipologías procedurales residuales y la etiqueta "Estás en".

### 1.5 Más comercios y equipamientos

OSM tiene 868 comercios; Terrassa tiene varios miles. Fuentes: (a) censo de actividades del Ajuntament (datos
abiertos, con dirección), geocodificado contra las direcciones del Catastro (el GML `addresses` enlazado ya da
portal por referencia catastral); (b) completar OSM. Con direcciones catastrales los rótulos irían al **portal exacto**,
no al muro más próximo.

### 1.6 Árboles y alumbrado reales

Inventari d'arbrat viari e inventario de alumbrado del Ajuntament (datos abiertos): posición, especie y tipo de
farola de cada unidad. Sustituyen las alineaciones procedurales de `street-details.js` (hoy 🔴). Añadir especies
mediterráneas a `trees.js` (plátano ya; faltan tipuana, lledoner, morera, pi, alzina, xiprer).

### 1.7 Calzadas y aceras exactas

Base topogràfica 1:5.000 del ICGC: polígonos de calzada, acera, mediana, alcorques. Sustituye el modelo de anchos
(hoy 🟡 por clase de vía). Afecta al ráster de manzanas: regenerar y comparar recuentos (2.320 manzanas) para detectar
cambios inesperados.

### 1.8 Interior de parques y plazas

Caminos reales (`highway=footway/path` dentro de parques, no descargados aún), fuentes, pistas, juegos infantiles
(`leisure=playground`, ya descargado), mobiliario de OSM. Especialmente Vallparadís (con relieve real del 1.1), la
Plaça Vella (sin árboles en rejilla), el Parc de Sant Jordi.

### 1.9 Pasos de cebra y señales reales

Los 3.971 pasos de OSM (`roadGraph.crossings`) ya están en los datos: pintarlos (`road-paint.js`) y usarlos para
que los peatones crucen por ellos sin semáforo (hoy solo cruzan en cruces semaforizados). Señales de stop/ceda
(`n.stop`, 313 cruces) para la prioridad del tráfico. Riesgo bajo: todo aditivo.

### 1.10 Detalles que delatan "Manhattan"

Revisar y sustituir restos de la iconografía original: contenedores (los de Terrassa son los de carga lateral,
grises/verdes/azules/amarillos/marrones), papeleras, bancos, marquesinas de bus (TMESA), paradas con poste, bolardos,
cabinas, fuentes, alcantarillas. Todo instanciado y barato.

---

## Eje 2 · Motor: conducción, física, tráfico, semáforos, policía, peatones

### 2.0 Síntomas observados en el navegador → causa en el código → acción

| Síntoma | Causa comprobada | Acción (apartado) |
|---|---|---|
| ~~El coche atraviesa árboles, farolas, bancos, bolardos, semáforos~~ ✅ (2026-10-25) | Era: el jugador solo colisionaba con `allColliders`. Ahora `street-details.js`/`city-grid.js` exportan `obstacles` (cilindros) y `propBoxes` (bancos) y `controllers.js` los resuelve (`FEATURES.propCollisions`, `VDR-0030`) | 2.1.1 |
| Semáforos siempre en rojo | Un solo reloj global (`SIGNAL_TIMING`, 60 s, todos los cruces en fase) | 2.3 |
| Coches acumulados / atascos | Varias causas: (a) los coches aparecen en cualquier arista a < 350 m del jugador elegida al azar, así que las zonas con muchas aristas cortas (casco antiguo) reciben más coches por metro; (b) no hay destino: en cada cruce eligen giro, y en los cruces con prioridad por "vía más ancha" las secundarias esperan sin límite; (c) bloqueos mutuos en la caja del cruce (`boxBusy`) sin detección de interbloqueo; (d) rotondas colapsadas en un nodo; (e) vías de sentido único que desembocan en calles saturadas | 2.4 |
| Zonas con un montón de peatones y otras vacías | Igual que (a): aparición por arista al azar a < 350 m; nada depende del uso del suelo, de los comercios ni de la hora | 2.6 |
| El tráfico "se ve raro" | Sin distancia de seguridad dependiente de la velocidad, sin indicadores, giros bruscos, sin velocidad por tipo de vía, sin aparcamientos en calzada | 2.4, 2.5 |

### 2.1 Física y colisiones del coche

**Estado (2026-10-25, sesión 4, `HOW_TO_IMPROVE.md` §3 y §5.8, `VDR/0028`–`0033`).** Hecho detrás de `FEATURES`:
`propCollisions` (postes, semáforos, bolardos, papeleras, troncos como cilindros; bancos como cajas), `carPhysics`
(modelo de cuatro ruedas de `js/vehicle-physics.js`: muelles independientes, neumáticos saturables, ABS/TCS, freno de
mano, cambio automático, gravedad en pendiente), `vehicleGarage` (seis vehículos, tecla `G`), `enterExit` (subir y
bajar con `F`, bicis aparcadas de `js/parked-bikes.js`). Lo que sigue abajo queda como referencia; lo **pendiente** de
cada apartado se marca con ⚪.

**2.1.1 Chocar con lo que hay — ✅ hecho salvo bordillos y props rompibles.**
- Unificar colisionadores: `main.js` construye una sola **tabla de colisión** con tres clases: *sólido alto* (edificios,
  monumentos: ya), *sólido bajo* (troncos de árbol ø 0,3–0,6 m, farolas, semáforos, bolardos, papeleras, bancos,
  marquesinas, contenedores, parapetos) y *franqueable* (setos, alcorques). `street-details.js` y `city-grid.js` ya
  devuelven `footprints`; basta añadirles `kind` y `radius`, y que `controllers.js` los incluya en `nearColliders`
  (celdas de 48 m ya existentes).
- Respuesta física: cilindro (tronco/poste) vs caja del coche → impulso de rebote proporcional a la velocidad y al
  ángulo, el coche pierde velocidad y se desvía; a baja velocidad se detiene sin "pegarse" (deslizar a lo largo del
  obstáculo). Para el peatón y la bici: deslizar.
- ⚪ Bordillos: subir la acera a baja velocidad con un pequeño salto y traqueteo; a alta velocidad frenar; el jugador
  puede conducir por la acera (como en GTA) pero con penalización de velocidad y los peatones apartándose. (El modelo
  de cuatro ruedas ya reacciona a un escalón bajo una rueda: basta que `getGroundHeight(..., 'car')` devuelva la acera
  en vez de `roadHeightAt` cuando el coche está sobre una isla.)
- ⚪ Props rompibles (opcional, fase 2): bolardos, papeleras y señales caen al ser atropellados (instancia que gira y
  se tumba, sin física continua).
- ⚪ Props que aún no existen como objeto (y por tanto no chocan): marquesinas, señales verticales, terrazas,
  contenedores, setos.
- Coches del tráfico y jugador: el tráfico ya empuja y es empujado por el jugador (`collideWithPlayer`); ⚪ falta que el
  otro pite y se quede parado unos segundos.

**2.1.2 Modelo de conducción — ✅ hecho como simulador ligero (`js/vehicle-physics.js`, `VDR-0028`); pendientes ⚪:**
- Bicicleta dinámica con masa (1.300 kg), inercia de guiñada y **neumáticos con fuerza lateral saturable**
  (Pacejka simplificada): subviraje natural, derrape al frenar fuerte en curva, freno de mano para girar en
  seco (muy satisfactorio en el casco antiguo).
- Aceleración limitada por adherencia (patina al salir en mojado), reparto de frenada 60/40, ABS sencillo.
- **Pendiente**: el relieve ya existe (1.1) y el coche cabecea y balancea con la superficie que pisa; falta la gravedad longitudinal y lateral (que cueste subir, que se vaya en bajada).
- Suspensión real en el chasis: 4 muelles-amortiguador que responden al balanceo, al cabeceo y a bordillos;
  transferencia de carga que afecta al agarre.
- Caja de cambios automática de 6 marchas (hecha para la curva de aceleración y el HUD); ⚪ que el **sonido del motor**
  siga las rpm y la marcha del modelo (`audio-sources.js` aún deriva la carga de las teclas) y chirrido de neumáticos
  desde `state.skid`.
- ⚪ Marcha atrás con la cámara girada, luz de marcha atrás (hay hueco en `carState`), volante animado en la vista POV.
- ⚪ Cámara: retardo según aceleración lateral, FOV con la velocidad, vibración al ir por adoquines (la Plaça Vella
  y las calles peatonales con `surface=sett|cobblestone` de OSM, ya descargado en `osm_roads.json` pero no usado) y
  **agarre por superficie** (`env.grip` ya existe en el modelo: adoquín 0,85, mojado 0,6).
- ⚪ Daño visual acumulativo opcional (abolladuras por decal).
- Conmutador `FEATURES.carPhysics` ✅; pruebas numéricas en `tests/vehicle-physics.test.cjs` (frenada 50→0 km/h en
  8,7–10,7 m; ~0,7 g en curva y saturación cerca de 1 g; poste a 50 km/h en `tests/controllers.test.cjs`).

**2.1.3 Bicicleta y peatón.** Inclinación real en curva con límite de agarre, pedaleo con cadencia, caída si
se gira demasiado rápido (reinicio suave). Peatón: escaleras y rampas cuando haya relieve, empujar y esquivar.

### 2.2 Mundo con el que interactuar

- **Puertas y pasos**: nada que entrar aún, pero sí pasajes (`highway=pedestrian` bajo edificios) y porches.
- **Aparcamientos en calzada**: hileras de coches aparcados reales (OSM `parking:lane=*` cuando existe; si no, por
  clase de vía) que ocupan el carril de aparcamiento modelado (§2.2 del diario): hace las calles reconocibles y
  explica el ancho de calzada.
- **Objetos dinámicos sencillos**: toldos que se mueven con el viento, persianas, banderas, ropa tendida en los
  patios de illa (muy Terrassa), pelotas en las pistas.

### 2.3 Semáforos reales (y que no estén "siempre en rojo")

**Diagnóstico.** Hoy hay **un único reloj global**: todos los cruces de la ciudad cambian a la vez con el mismo ciclo
de 60 s (26 s verde principal / 26 s verde secundaria). Al circular, el siguiente cruce suele estar en la fase opuesta,
de ahí la sensación de rojo constante. Además las vías "secundarias" de un cruce de 3+ ramales comparten fase.

**Propuesta.**
1. **Desfase por cruce (onda verde).** Cada nodo semaforizado recibe un `offset` = distancia a lo largo de su vía
   principal desde el inicio del eje ÷ velocidad de diseño (40 km/h). Vías con semáforos coordinados en Terrassa:
   Rambla d'Ègara, Avinguda de Jacquard, Carretera de Montcada, Avinguda del Vallès, Carretera de Rubí, Avinguda de
   Béjar, Avinguda de les Glòries Catalanes, Avinguda de l'Abat Marcet. Implementación: `n.offset` en
   `road-network.js`; `phaseOf(e)` en `traffic.js` y las cabezas de `street-details.js` leen
   `signalPhase(elapsed - n.offset, …)`. El audio de semáforos peatonales (`audioSignals`) idem.
2. **Ciclos por tipo de cruce.** Dos vías principales: 90 s; principal con secundaria: 60 s con reparto 60/40; cruce
   con solo paso peatonal (los 114 nodos `traffic_signals` sin cruce de vías): verde fijo para coches salvo cuando un
   peatón pide paso (botón: el peatón IA "pulsa" al llegar).
3. **Fases por grupo real.** Cruces de 3+ ramales: una fase por grupo (`n.groupCount`) en lugar de "principal/resto".
   Giros a la izquierda protegidos en avenidas con mediana (Rambla, Vallès).
4. **Ámbar intermitente nocturno** (modo "Night") en cruces secundarios, como en la realidad.
5. **Semáforo visible desde el coche**: repetidor en el lado derecho a la altura del conductor (ya hay poste; añadir
   cabeza baja), y ámbar de 3 s antes del rojo también en los pasos de peatones (hombre verde parpadeante).
6. **Planes reales**: si el Ajuntament publica el inventario de semáforos y sus planes de fases, sustituir las tablas.

**Riesgo.** Medio: el tráfico IA y los peatones dependen de las fases. Mitigación: `offset = 0` reproduce exactamente
el comportamiento actual; los tests de tráfico siguen válidos; añadir una prueba de que en ningún cruce dos grupos
tienen verde a la vez.

### 2.4 IA de tráfico: que circule como una ciudad

**2.4.1 Aparición equilibrada (resuelve las acumulaciones, bajo riesgo).**
- Presupuesto de coches **por metro de carril y clase de vía**, no por arista: ponderar la elección de arista por su
  longitud × factor de clase (avenida 1,0; residencial 0,35; servicio 0,1; peatonal 0) y limitar la densidad máxima
  por tramo (un coche cada 12 m en avenida, cada 25 m en residencial).
- Aparición preferente en los **bordes de la zona activa** (anillo 250–350 m) y nunca justo delante del jugador;
  desaparición al salir por el lado opuesto, de forma que el flujo cruza la zona en vez de nacer y morir dentro.
- **Curva horaria** (ver 2.6) y **factor de zona**: polígonos industriales con tráfico pesado en horas laborales,
  casco antiguo casi vacío (zona de prioridad invertida / peatonal), rondas siempre cargadas.

**2.4.2 Destinos y rutas.** Cada coche recibe un destino (nodo del grafo elegido por atractores: el Centre, la
Mútua, los polígonos, las salidas a las rondas, la estación) y una ruta A* sobre `roadGraph` (5.167 nodos; precalcular
rutas entre 200 atractores y reutilizarlas). Ventajas: giros coherentes (el coche no cambia de carril al azar), flujos
realistas, autobuses por sus líneas, y la posibilidad de misiones de taxi.

**2.4.3 Comportamiento de seguimiento (IDM).** Sustituir la lógica de "frenar si hay alguien delante" por un
modelo de conductor inteligente (distancia deseada = 2 m + v·1,2 s; aceleración/frenado suaves; variación por
conductor: agresivo/tranquilo). Elimina acordeones y choques visuales. Velocidad objetivo por vía: 30 km/h
residencial y Zona 30 (todo el casco antiguo y el Eixample lo son), 50 avenidas, 80–120 rondas (`maxspeed` de OSM ya
está en `osm_roads.json`; falta exportarlo en `roads`).

**2.4.4 Cruces.** Detección y resolución de **interbloqueos** (si dos coches llevan > 6 s esperándose, el de menor
prioridad retrocede o cede); tiempo máximo de espera en secundarias (al cabo de 20 s se cuela "a la catalana" si hay
hueco de 3 s); **aceptación de huecos** real para incorporaciones; **rotondas** como anillo con prioridad al que
circula dentro (hoy los nodos a < 14 m se fusionan: excluir de la fusión los `roundabout` del grafo, ya marcados en
el dato); stop y ceda el paso (`n.stop`, 313 cruces) respetados.

**2.4.5 Carriles.** Cambio de carril para adelantar lentos y para colocarse antes del giro (Rambla, avenidas de 2+
carriles), intermitentes (ya hay estado de luces), paradas en doble fila cortas (repartidores) que obligan a rodear.

**2.4.6 Vehículos.** Autobuses de TMESA por sus **líneas reales** (OSM `route=bus` y `highway=bus_stop`: añadir a la
consulta Overpass) parando en las paradas con marquesina; furgonetas de reparto, camiones en polígonos, motos y
bicis (carril bici de OSM `cycleway=*`), patinetes; taxis que paran a recoger; el vehículo del jugador también
"existe" para la IA (hoy lo esquivan; que también le pitén y le dejen pasar si va con sirena, 2.5).

**2.4.7 Verificación.** `tests/traffic-performance.test.cjs` fija el presupuesto de CPU (< 2 ms/frame con 400 coches);
nuevas pruebas: ningún coche parado > 60 s sin causa (semáforo/cola), densidad por tramo dentro del límite, y una
prueba de humo de 5 minutos simulados sin interbloqueos en el casco antiguo.

### 2.5 Policía: Mossos y Policia Municipal, con criterio

**Hecho (2026-10-25, `FEATURES.emergencyStates`, `VDR-0031`).** Dos cuerpos alternos (Policia Municipal berlina,
Mossos d'Esquadra SUV con librea propia aproximada), estado de **patrulla** por defecto (sin luces ni sirena, respeta
semáforos) y **emergencias** solo a petición (`startEmergency()`; el propietario no quiere que arranquen solas) con
luces, sirena y prioridad. Quedan ⚪: la reacción del tráfico (apartarse), el estado "parado con luces", las
ambulancias del SEM y Bombers, afinar las libreas (ya repintadas con fotos y texto real; faltan escudos, el rotulado
de las lunas, luces de calandra; un loft de monovolumen/SUV compacto para el Prius+ y el Kuga), que el tráfico **se
aparte** del coche del jugador con la sirena puesta, grabaciones reales para afinar los cuatro tonos de sirena, y la
persecución opcional.

**Antes.** 1 de cada 60 coches era policía (librea Policia Municipal), **siempre con sirena** y con luces fijas.

**Propuesta.**
1. Dos cuerpos: **Policia Municipal de Terrassa** (blanco con banda ajedrezada azul/amarilla, cerca del Centre y en
   el tráfico ordinario) y **Mossos d'Esquadra** (blanco con azul oscuro y franja roja, luces azules, más en rondas y
   accesos). Un tercer vehículo: ambulancia del SEM amarilla; opcional Bombers rojo. Librea = una posición más de
   `carState.w`.
2. **Estados**: patrulla (sin sirena ni luces, respeta semáforos y límites), emergencia (luces + sirena bitonal,
   salta semáforos, los demás se apartan) y parada (aparcado con luces, agentes de pie). La emergencia salta de
   forma aleatoria (una cada ~4 minutos cerca del jugador) y se extingue al llegar a un destino.
3. **Reacción del tráfico**: los coches ceden al vehículo en emergencia (frenan y se arriman al bordillo).
4. **Sirena**: bitonal ya existe en `audio-synthesis.js`; añadir "yelp" en los cruces y silencio en patrulla.
5. Opcional (modo juego): la Policia Municipal persigue al jugador si atropella o circula por la acera; nivel de
   búsqueda que baja al esconderse.

### 2.6 Peatones: densidad por lugar y por hora

- **Mapa de atracción**: peso por tramo de acera = base por tipo de calle + comercios cercanos (764 reales, kind
  bar/tienda pesan más) + equipamientos (estaciones, mercados, escuelas, hospital, universidad, parques, plazas) +
  densidad de viviendas del Catastro (`dwellings` por manzana, ya en los datos). El casco antiguo y la Rambla deben
  tener 10× más gente que un polígono.
- **Curva horaria** (hora del modo de luz + reloj continuo si se implementa 2.8): madrugada casi vacío, 8–9 h
  escolares y trabajadores, 12–14 h comercios, 17–20 h paseo, noche terrazas; sábados mercado; domingos Vallparadís.
- **Aparición** proporcional al peso del tramo (muestreo por ruleta), presupuesto global por FPS como hoy, y
  desaparición al salir de la zona.
- **Comportamientos**: grupos (2–4 que caminan juntos y hablan, ya hay conversaciones), terrazas (sentados en
  sillas frente a los bares reales), colas en paradas de bus, gente mirando escaparates, esperar en el bordillo y
  cruzar por los **pasos de cebra** (ya en datos: 3.971), apartarse del coche en la acera, correr si llueve.
- **Variedad visual**: edades (niños con adultos, mayores), ropa por estación, bolsas de compra, perros.

### 2.7 Peatón, bici y helicóptero del jugador

Escaleras y rampas con relieve, entrar en el Parc de Vallparadís por sus accesos reales, helicóptero con
aterrizaje en el Estadi/Mútua y viento; bici con carriles bici reales y aparcabicis.

### 2.8 Tiempo, clima y vida

- **Reloj continuo** (hoy 4 presets): el sol recorre el cielo (posición real para 41,56° N), luces de los pisos que
  se encienden al anochecer por viviendas reales, farolas con encendido escalonado, comercios que cierran.
- **Clima**: lluvia de otoño con charcos y reflejos (ya hay SSR), viento (toldos, árboles), calima de verano,
  niebla matinal del Vallès.
- **Sonido**: ambiente por zona (Rambla con terrazas, polígono con naves, Vallparadís con pájaros), campanas de la
  Catedral a las horas, trenes en la estación.

### 2.9 Rendimiento del motor

112k colisionadores y 110k cajas de fachada: fusionar volúmenes contiguos de igual altura (reduce ambos a la mitad),
LOD de fachada por distancia (ya existe), streaming de colisionadores por celda, tráfico y peatones por celdas de 100 m
con actualización a menor frecuencia lejos del jugador, y medir con el arnés + `hud-fps` en un recorrido fijo.

## Eje 3 · Monumentos reconocibles

**Método para cada uno:** (1) reunir 3–6 fotos (fachada principal, lateral, aérea del ICGC) y el plano de OSM/
Catastro; (2) sacar proporciones medibles de la ortofoto (planta) y de las fotos (alturas relativas, número de vanos,
ritmo de arcos); (3) modelar en `landmarks.js` con las primitivas existentes (`archesAlong`, `ribbedDome`, `tower`,
`sawtoothRoof`…) o, si hace falta, un GLB low-poly hecho a medida y cargado con `GLTFLoader` (poner el fichero en
`assets/`, ≤ 1 MB); (4) captura antes/después. Las fotos para referencia se pueden buscar con permiso (Wikimedia
Commons tiene muchas de Terrassa con licencia libre, útil para no depender de la memoria).

Orden sugerido (impacto visual × facilidad):

1. **Catedral del Sant Esperit** (Plaça Vella): campanario neogótico de 1877, nave de 1601, fachada de piedra
   con rosetón. Comprobar la altura real del campanar (~50 m) y el ritmo de ventanas; añadir el cimborio real.
2. **Hospital Universitari Mútua Terrassa**: la torre (1970s, 17 plantas según OSM, 19 según Catastro) con sus
   bandas horizontales de hormigón y antepechos; hoy es una extrusión con fachada genérica. Es el edificio más
   visible desde todas partes: merece fachada propia (bandas) y el conjunto de pabellones bajos.
3. **Masia Freixa**: ya hay modelo; afinar con fotos el número y tamaño de cúpulas (hay una grande central y varias
   menores), la arcada parabólica continua de la planta baja, la torre con cúpula y la cerámica verde. Considerar GLB.
4. **mNACTEC**: comprobar las dents de serra (orientación y número) con la ortofoto; la fachada de ladrillo de la
   Rambla con sus ventanas en arco; la chimenea.
5. **Mercat de la Independència**: estructura de hierro modernista; la planta de OSM parece incluir anexos: usar
   la huella del Catastro.
6. **Seu d'Ègara**: tres iglesias con proporciones muy concretas (Sant Miquel es cuadrada con cúpula sobre ocho
   columnas, Santa Maria con cimborio, Sant Pere con ábside trilobulado). Hay planos publicados.
7. **Castell Cartoixa de Vallparadís**, **Torre del Palau**, **Ajuntament**, **Teatre Principal**, **Casa Alegre de
   Sagrera**, **Estació del Nord**, **Estadi Olímpic**, chimeneas (la de la Bòvila Almirall es un hito de 63 m).
8. Nuevos: **Parc Audiovisual (antic Hospital del Tòrax)**, **Vapor Gran**, **Escola Industrial**, **Casa Baumann**,
   **Catalunya Caixa / edificio de la Caixa de Terrassa**, **Centre Cultural**, **Mercat de Sant Pere**, **Torre
   Mossèn Homs**, **Can Amat**, **Gran Casino**, el **Pont del Passeig** sobre Vallparadís (con relieve).

**Riesgo.** Nulo para el resto del motor: cada monumento es una función aislada en `landmarks.js`, y `buildings.js`
ya reserva su recinto.

---

## Eje 4 · Infraestructura del proyecto

- **Prueba de humo en navegador**: ✅ `tools/browser-smoke.mjs` (Chrome headless por DevTools Protocol, sin
  dependencias; gancho `window.__slop` en `main.js`). Pendiente: convertir sus métricas (volúmenes enterrados, props
  flotantes, vértices por material, tiempos de `[init]`) en umbrales de regresión y guardar las capturas del recorrido
  de prueba en `docs/`.
- **Informe procedimental del relieve**: ✅ `tools/geo-terrain.mjs` lo imprime en cada regeneración; pendiente
  fijarle umbrales (p. ej. 0 escalones > 1 m en calzada) y hacerlo fallar.
- **`FEATURES`** en `city-config.js` como único sitio de conmutadores: ✅ (`terrain`, `terrainFile`, `terrainTile`).
- **Versionado de datos**: `GEO.version` y fecha de descarga de cada fuente en el diario (el MDE del ICGC está
  archivado comprimido en `tools/data/dem/` para no depender del servicio).
- **Decisiones**: cada decisión significativa va a `VDR/` (regla en `CLAUDE.md`).
- **Rama por mejora grande** (física) y `main` siempre arrancable.

---

## Priorización propuesta

| # | Mejora | Impacto | Esfuerzo | Riesgo | Depende de |
|---|---|---|---|---|---|
| 1 | ~~Colisiones con árboles, farolas y props; respuesta de choque (2.1.1)~~ ✅ hecho (quedan bordillos y props rompibles) | Alto | Bajo | Bajo | — |
| 2 | Semáforos con desfase y ciclos por cruce (2.3) | Alto (se nota al minuto) | Bajo | Medio | — |
| 3 | Aparición equilibrada de coches y peatones por tramo, zona y hora (2.4.1, 2.6) | Alto | Bajo-medio | Bajo | — |
| 4 | ~~Policía con estados, Mossos, sirena solo en emergencia (2.5)~~ ✅ hecho (queda que el tráfico se aparte, SEM) | Alto | Bajo | Bajo | — |
| 5 | Seguimiento IDM, interbloqueos, rotondas, velocidades por vía (2.4.3, 2.4.4) | Alto | Medio | Medio | — |
| 6 | ~~Física de conducción (2.1.2)~~ ✅ hecha como simulador ligero; quedan sonido por rpm, agarre por superficie, bordillos | Alto | Medio | Medio | — |
| 7 | Pasos de cebra pintados y peatones cruzando por ellos (1.9) | Medio | Bajo | Bajo | — |
| 8 | Monumentos con fotos: Catedral, Mútua, Masia Freixa, mNACTEC (3) | Alto | Medio | Nulo | fotos |
| 9 | Tráfico con destinos y rutas; autobuses de TMESA por sus líneas (2.4.2, 2.4.6) | Alto | Medio-alto | Medio | paradas OSM |
| 10 | ~~Relieve real (1.1)~~ ✅ hecho; quedan pasos superiores sin etiqueta, túneles y pilas de puente (1.1 "Lo que queda") | Medio | Medio | Medio | — |
| 11 | Alturas LiDAR y cubiertas (1.2, 1.3) | Medio-alto | Medio | Bajo | LiDAR/ortofoto ICGC |
| 12 | Comercios con direcciones (1.5), árboles y farolas reales (1.6) | Medio | Medio | Bajo | datos Ajuntament |
| 13 | Barrios oficiales (1.4), calzadas ICGC (1.7), parques (1.8) | Medio | Medio | Bajo-medio | datos |
| 14 | Reloj continuo, clima, aparcamientos en calzada, mobiliario terrassenc (2.8, 2.2, 1.10) | Medio | Variable | Bajo | — |
| 15 | Rendimiento: fusión de volúmenes, streaming de colisionadores (2.9) | Medio | Medio | Medio | — |

Recomendación: el relieve (**10**), las colisiones (**1**), la policía (**4**) y la física (**6**) ya están; ahora
**2 + 3** (semáforos con desfase, aparición equilibrada) y **5** (seguimiento IDM, interbloqueos, rotondas, velocidades
por vía), luego los flecos de la sesión 4 (sonido del motor por rpm, bordillos, el tráfico apartándose de las
emergencias, aparcabicis reales de OSM con permiso de red), después **8** con fotos, y en paralelo los flecos del
relieve (pasos superiores, túneles) y los datos de **11**.
