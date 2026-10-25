# VDR-0035 — Les llibrees dels vehicles es pinten a partir de fotografies, mai de memòria

- **Data:** 2026-10-25
- **Estat:** Acceptada (regla de treball; modifica les conseqüències de VDR-0029 i VDR-0031)

## Context

La sessió 4 va pintar la llibrea dels Mossos d'Esquadra "de memòria" (banda blava fosca i línia vermella) i va
mantenir la del taxi heretada de la sessió 1 (franja diagonal vermella i blava, també inventada) i la de la Policia
Municipal (escacs blaus i grocs). A la primera prova el propietari les va rebutjar: els Mossos "són lletjos", no vol
res fet de memòria, i taxi i Policia Municipal han de ser realistes i dels darrers models. Amb el seu permís explícit
(VDR-0010) es van buscar i descarregar referències: Wikimedia Commons ("Seat Ateca dels Mossos 01–03", "SEAT Arona -
Mossos d'Esquadra"), Cugat Mèdia (cinc Ateca nous, 2025), Ara.cat i El Motor de Girona (la imatge corporativa de 2020),
la nota de premsa de Toyota España (deu Prius+ per a la Policia Municipal de Terrassa, 2019), taxiterrassa.info i
MónTerrassa (taxis de Terrassa 2019–2022). El que s'hi va veure contradiu la memòria: el taxi de Terrassa és blanc
llis amb una escala de quadradets vermells i l'escut, sense cap franja diagonal; la Policia Municipal porta les
portes blaves amb rombes i una franja groc-verd fluorescent; els Mossos tenen el capó blau marí i una banda amb talls
blancs i vermells sobre un faldó d'escacs vermells i blancs.

## Decisió

- **Cap llibrea, rètol ni distintiu d'un cos o servei real es pinta de memòria.** Es busca una referència
  fotogràfica (amb permís de xarxa) o es deixa el vehicle sense distintiu i marcat ⚪ a `HOW_TO_IMPROVE.md`.
- Cada llibrea cita les seves fonts a `HOW_TO_IMPROVE.md` §5.1 i diu què queda aproximat (text com a traços, escuts
  simplificats, elements omesos).
- Les referències descarregades viuen fora del repositori (scratchpad de la sessió): no s'hi incorporen imatges de
  tercers.
- Aplicat avui a `js/actor-models.js` (`createLoftedCarMaterial`: taxi, Policia Municipal, Mossos) i a la calca del
  taxi del jugador (`js/controllers.js createTaxiDoorDecalTexture`).

## Alternatives considerades

- **Deixar les llibrees aproximades i marcar-les 🟠**: era l'estat anterior i el propietari el va rebutjar.
- **Carregar fotos com a textures**: descartat, drets de tercers i cap pipeline d'actius; les llibrees es pinten
  procedimentalment al shader a partir del que es veu a les fotos.

## Conseqüències

- Les tres llibrees passen de 🟠 a 🟡 (fonts citades, detalls aproximats). Queden ⚪: escuts (Generalitat, Ajuntament),
  text real en comptes de traços, chevrons posteriors dels Mossos, "112" a la lluna, chevrons grocs del paraxocs de la
  Policia Municipal, i una carrosseria de monovolum/SUV compacte per al Prius+ i el Kuga reals.
- La mateixa regla val per als autobusos de TMESA (llibrea "de memòria" de la sessió 1, encara 🟠) i per a qualsevol
  ambulància o Bombers futurs.

*Un polsim de Viandox:* la recepta de l'àvia es copia del seu quadern, no del que un creu recordar del dinar.
