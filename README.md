# Mapa de Tiendas

**Español** · [English](#english)

Base de datos de tiendas retail del Perú y generador de **láminas de mapas listas para presentar**.
Eliges los distritos y las cadenas, y la app arma la lámina completa —título, distritos, Peso,
mapa con los logos ordenados automáticamente y la leyenda roja «Tiendas» con los conteos— para
exportarla a **PowerPoint editable, PNG o un mapa interactivo HTML**. Reemplaza el trabajo de
pegar logos a mano sobre capturas de mapas.

## Cómo abrirla

- **Sin instalar nada:** descarga la carpeta completa del proyecto y haz **doble clic en
  `index.html`** (Chrome o Edge).
  - Si la descargaste como ZIP desde GitHub: clic derecho en el ZIP → **Extraer todo…** y abre
    `index.html` desde la carpeta extraída. Abierto dentro del ZIP no funciona (la app lo avisa).
  - Necesita internet solo para el mapa base, la búsqueda de direcciones y el escaneo de
    OpenStreetMap. Las tiendas, los logos y los distritos vienen dentro de la carpeta.
- **En línea:** <https://pebrauner.github.io/mapa-tiendas/>

Usa **una sola pestaña** a la vez: si abres la app dos veces, la pestaña anterior queda en pausa
para que ninguna borre los cambios de la otra (botón «Seguir en esta pestaña» para retomarla).

## Para empezar: el proyecto de ejemplo

¿Quieres ver primero cómo queda? En la pestaña **Mapas** pulsa **Ver ejemplo con 4 regiones** (o
menú del proyecto **⋮ → Abrir proyecto de ejemplo**). Se abren cuatro láminas armadas como las del
deck de referencia —**Lima Metropolitana Sur** (con un radio de 1 km), **Lima Cono Sur**,
**Trujillo** y **Chimbote**—, con sus distritos, cadenas y Peso. Puedes cambiarlas, exportarlas o
guardarlas como tu propio proyecto. Si tienes un proyecto con cambios sin guardar, la app te ofrece
guardarlo antes; nunca lo reemplaza sin preguntar.

## Primera lámina en 5 minutos

1. Pestaña **Mapas** → la lámina 1 ya está creada. Escribe el **título** (p. ej. «Lima
   Metropolitana Sur») y el **Peso** (p. ej. `15.8%`).
2. En **Distritos**, escribe un nombre y pulsa Enter (*Miraflores*, *Surco*, *SJL* también
   funcionan) o usa **Zonas de Lima** para agregar una zona completa. El subtítulo
   «(Miraflores, San Borja, …)» se arma solo.
3. En **Cadenas**, enciende o apaga las cadenas (Tambo y Oxxo vienen apagadas). La leyenda muestra
   solo lo que se ve en el mapa, con su conteo: `PLAZA VEA (6)`.
4. Ajusta el encuadre con la rueda del mouse o arrastrando el mapa («Volver al automático» lo
   deshace). Si un logo no te gusta donde quedó, **arrástralo**; doble clic lo devuelve a su sitio.
5. Opcional: clic en una tienda → **Agregar radio** (500 m / 1 km / el que quieras) para ver
   cuántas tiendas propias y de la competencia hay alrededor.
6. **Exportar ▾** → PowerPoint, PNG de la lámina o del mapa, o mapa interactivo. **Ctrl+S** guarda el
   proyecto como archivo `*.mapa.json` para retomarlo después.

Cuando el mapa está muy lleno (por ejemplo, un cono de Lima con decenas de tiendas), las tiendas
cercanas de una **misma cadena se agrupan en un solo logo con su número** («×4»): cada tienda
conserva su punto en el mapa y cuenta igual en la leyenda. Es automático; en **Logos y leyenda**
el interruptor «Agrupar tiendas cercanas de la misma cadena» lo fuerza o lo apaga para esa lámina.
Si aun así un logo no entra cerca de su tienda, esa tienda se dibuja como un **punto del color de
su cadena**; la app lo avisa y sugiere achicar los logos o usar el estilo «Puntos».

Los nombres de los distritos elegidos siempre aparecen en el mapa: cuando el mapa base no los
escribe a ese zoom (los distritos de Lima vistos de lejos), la app los escribe con el mismo estilo,
y los logos y sus líneas guía se apartan de ellos.

## Agregar y corregir tiendas

Pestaña **Base de datos**:

- **Agregar tienda:** busca la dirección (Enter), haz clic en el mapa, o pega coordenadas o un
  enlace de Google Maps (`-12.1219, -77.0297`, `12.12 S 77.03 O`, `…/@-12.12,-77.03,17z…`).
- **Editar:** doble clic en una fila. Arrastra el pin para corregir la ubicación. **Ctrl+Enter**
  guarda.
- **Importar** CSV o Excel: las columnas se reconocen solas (Cadena, Nombre, Dirección, Distrito,
  Latitud, Longitud, Estado…). Los CSV guardados por Excel en Windows se leen bien (tildes y ñ).
  Las filas que solo tienen dirección se ubican por su dirección (una por segundo). Usa
  «Actualizar por ID» solo con archivos exportados desde esta app.
- **Escanear OSM:** busca en OpenStreetMap las tiendas de las cadenas elegidas en un área
  (distritos, provincia o departamento) y muestra qué es nuevo, qué se movió y qué ya no aparece
  (posiblemente cerrada). Usa las mismas reglas que la base publicada (`data/chains.js`): descarta
  los parecidos («Metro de Lima», «Tambo de Mora», estacionamientos, cajeros…) y marca como
  «Dudosa» lo que tiene etiquetas atípicas. Tú decides qué aceptar; nunca borra nada.

### Guardar la base de datos

Los cambios a tiendas, cadenas y logos se guardan primero **solo en este navegador** («N cambios
locales» arriba). Para incorporarlos a los archivos del proyecto:

1. **Base de datos → Guardar en carpeta** y elige la carpeta de la app (la que tiene `index.html`).
   Chrome/Edge escriben `data/stores.csv`, `data/stores.js`, `data/chains.js` y `logos/logos.js`.
   Si eliges otra copia de la app (por ejemplo una versión anterior), la app no guarda y te lo dice.
2. Para que todo el equipo los vea: **commit y push** a GitHub (por ejemplo con GitHub Desktop).
   La versión en línea se actualiza sola en uno o dos minutos.

Si el navegador no guarda datos de sitios (ventana de incógnito o una política de la empresa), la
app muestra un aviso rojo: guarda el proyecto y usa «Guardar en carpeta» antes de cerrar.

## Exportaciones

| Formato | Qué obtienes |
|---|---|
| **PowerPoint (.pptx)** | Una lámina 16:9 por mapa, editable: título real (marcador de título), textos, cada logo como imagen, guías conectadas a su logo, leyenda; el mapa completo es un grupo «Mapa» que se mueve y escala como un solo objeto. El estilo «Números» agrega la tabla de tiendas. |
| **PNG de la lámina** | 1920 × 1080 o 3840 × 2160. |
| **PNG del mapa** | Solo el mapa, a 2×, 3× o 4×. |
| **Mapa interactivo (.html)** | Un archivo para abrir con doble clic: zoom, filtros por cadena, conteos de lo que está a la vista y el detalle de cada tienda. |

La vista previa es exactamente lo que se exporta (mismas posiciones de los logos).

## Datos y licencias

- **Mapa base:** © OpenStreetMap contributors · © OpenMapTiles · [OpenFreeMap](https://openfreemap.org).
  La atribución aparece en el mapa y en todas las exportaciones.
- **Tiendas:** las obtenidas de OpenStreetMap están bajo la licencia
  [ODbL](https://www.openstreetmap.org/copyright) (© OpenStreetMap contributors); el resto
  proviene de los localizadores de tiendas de cada cadena y de registros propios.
- **Distritos:** límites del INEI (referenciales).
- **Nombres de avenidas** (`data/road-names.js`): nombres y trazos simplificados de las vías
  principales de Lima y Callao y de 9 ciudades, tomados de los mosaicos de OpenMapTiles
  (© OpenStreetMap contributors, ODbL); el mapa base solo los nombra desde el zoom 14.
- **Logos:** los nombres y logos de las cadenas son marcas de sus respectivos dueños y se usan
  solo para identificar a cada cadena.
- **Código:** licencia MIT (ver [`LICENSE`](LICENSE)). Librerías de terceros en `vendor/`, cada
  una con su licencia ([`vendor/VERSIONS.md`](vendor/VERSIONS.md)).

## Estructura del proyecto

```
index.html     la app (abre con doble clic)
css/           estilos (core + uno por módulo)
js/            módulos de la app (scripts clásicos, espacio de nombres window.MT)
js/i18n/       textos en español e inglés
data/          tiendas (stores.csv = fuente, stores.js = generado), cadenas, distritos, nombres de avenidas
logos/         logos de las cadenas (PNG + logos.js con data URIs)
vendor/        MapLibre GL, PptxGenJS, SheetJS, Turf, topojson-client, fuentes
tools/         scripts de datos y pruebas (Node; no los necesita quien usa la app)
docs/          arquitectura, notas técnicas, guía de estilo, informe de pruebas
```

## Para desarrolladores

Sin build ni servidor: scripts clásicos bajo `window.MT`. Documentación:
[`SPEC.md`](SPEC.md) (requisitos y formatos), [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
(APIs y eventos), [`docs/TECH-NOTES.md`](docs/TECH-NOTES.md), [`docs/TEST-REPORT.md`](docs/TEST-REPORT.md).

```bash
cd tools && npm install          # una vez (puppeteer-core; usa el Chrome instalado)
node tools/test/run-all.mjs      # todas las pruebas con resumen (≈ 15 min)
node tools/test/e2e.mjs          # recorrido completo de un usuario en español e inglés
node tools/test/smoke.mjs        # arranque, pestañas, idiomas, datos faltantes
node tools/build-data.mjs        # regenera data/stores.js desde data/stores.csv
node tools/fixtures/build-example.mjs   # js/example-project.js desde tools/fixtures/demo.mapa.json
node tools/test/osm-rules.test.mjs      # escaneo OSM de la app = reglas de la semilla (vs data/stores.csv)
node tools/test/demo-slides.mjs         # 4 láminas de ejemplo: PNG, .pptx y render con PowerPoint (Windows)
node tools/build-road-names.mjs         # data/road-names.js: nombres de avenidas desde los mosaicos z14 (red)
```

«Guardar en carpeta» escribe `data/stores.csv` y `data/stores.js` en el mismo orden y formato que
`tools/build-data.mjs` (cadena, departamento, provincia, distrito, nombre), y `data/chains.js` en el
formato de `tools/merge.mjs` (con las reglas OSM `MT_OSM_RULES`): guardar sin cambios deja los
archivos idénticos byte a byte (`tools/test/data-roundtrip.test.mjs` lo comprueba). El
proyecto de ejemplo se edita en `tools/fixtures/demo.mapa.json` (también lo usan las pruebas) y se
publica en la app con `build-example.mjs`.

Las pruebas abren la app desde `file://` en Chrome sin ventana y fallan ante cualquier error de
consola. Capturas y archivos exportados quedan en `tools/test/out/`.

## Próximamente

**Análisis de canibalización** (fase 2): hoy cada lámina puede tener radios de 500 m / 1 km /
personalizados con el conteo de tiendas propias y de la competencia y su exportación a Excel. La
fase 2 extenderá esto a todas las tiendas: competidor más cercano de cada tienda, matriz de
superposición entre tiendas de una cadena, mapa de calor de densidad y comparación de áreas de
influencia entre cadenas. El diseño previsto está en `docs/ARCHITECTURE.md` §8.

---

<a id="english"></a>

# Mapa de Tiendas (English)

A database of retail stores in Peru and a generator of **presentation-ready map slides**. Pick the
districts and chains; the app builds the whole slide — title, districts, Peso, a map with neatly
placed chain logos and the red “Tiendas” legend with counts — and exports it as an **editable
PowerPoint, PNG or interactive HTML map**. It replaces hand-placing logos on map screenshots.

## Opening it

- **No install:** download the whole project folder and **double-click `index.html`** (Chrome or
  Edge). If you downloaded the GitHub ZIP, right-click it → **Extract All…** first and open
  `index.html` from the extracted folder. Internet is needed only for the base map, address search
  and the OpenStreetMap scan.
- **Online:** <https://pebrauner.github.io/mapa-tiendas/>

Use **one tab** at a time: opening the app again pauses the older tab so neither overwrites the
other’s work (“Keep working in this tab” resumes it).

## Start with the example project

Want to see the result first? In the **Maps** tab click **See an example with 4 regions** (or the
project menu **⋮ → Open example project**). It opens four slides built like the reference deck —
**Lima Metropolitana Sur** (with a 1 km radius), **Lima Cono Sur**, **Trujillo** and **Chimbote** —
with their districts, chains and Peso, ready to change, export or save as your own project. If your
current project has unsaved changes, the app offers to save it first; it never replaces it without
asking.

## Your first slide in 5 minutes

1. **Maps** tab → slide 1 exists. Type the **title** and the **Peso**.
2. **Districts:** type a name and press Enter (*Miraflores*, *Surco*, *SJL* work) or use the
   **Lima zones** presets. The “(Miraflores, San Borja, …)” subtitle builds itself.
3. **Chains:** switch chains on or off (Tambo and Oxxo start off). The legend lists only what the
   map shows, with counts.
4. Frame the map with the wheel or by dragging (“Back to automatic” undoes it). Drag any logo to
   move it; double-click puts it back.
5. Optional: click a store → **Add radius** to count own vs competitor stores around it.
6. **Export ▾** → PowerPoint, slide PNG, map PNG or interactive map. **Ctrl+S** saves the project
   as a `*.mapa.json` file.

On a crowded map, nearby stores of **one chain are grouped into one logo with a count** (“×4”):
every store keeps its dot and still counts in the legend. It is automatic; the “Group nearby stores
of the same chain” switch (Logos & legend) forces it on or off for that slide. When a logo still
has no room near its store, that store is drawn as a **dot in its chain colour**; the app suggests
smaller logos or the “Dots” style. The selected districts are always named on the map (the app
writes the names the basemap leaves out at that zoom), and logos and leaders keep off them.

## Adding and fixing stores

**Database** tab: **Add store** (address search, click on the map, or paste coordinates / a Google
Maps link), double-click a row to **edit** (drag the pin, Ctrl+Enter saves), **Import** CSV/Excel
(columns recognised automatically; Excel’s Windows CSV encoding is handled; address-only rows are
geocoded at one per second), and **Scan OSM** to find new, moved and possibly closed stores in an
area — you review and accept; nothing is deleted.

### Saving the database

Database changes live **only in this browser** at first (“N local changes”). To write them into the
project files: **Database → Save to folder**, choose the app folder (the one with `index.html`);
then **commit and push** to GitHub so everyone gets them (GitHub Pages updates in a minute or two).
The app refuses to save into a different copy of itself, and warns in red when the browser does not
keep site data (private window, company policy).

## Exports

Editable **PowerPoint** (one 16:9 slide per map; real title placeholder; every logo a picture;
leaders are connectors glued to their logo; the whole map is one “Mapa” group), **PNG slide**
(1920 or 3840 px wide), **PNG map** (2×–4×) and a standalone **interactive HTML map**. The preview
is exactly what gets exported.

## Data and licences

Base map © OpenStreetMap contributors · © OpenMapTiles · OpenFreeMap (attribution on every map and
export). Store data derived from OpenStreetMap is under the **ODbL** (© OpenStreetMap
contributors). District boundaries: INEI. Main avenue names (`data/road-names.js`, built by
`node tools/build-road-names.mjs` from the OpenMapTiles z14 tiles): ODbL, © OpenStreetMap contributors. **Chain names and logos are trademarks of their owners,
used only to identify each chain.** Code: MIT ([`LICENSE`](LICENSE)); third-party libraries in
`vendor/` keep their own licences.

## Project structure and development

See the Spanish section above for the folder layout and test commands
(`node tools/test/run-all.mjs`). “Save to folder” writes `data/stores.csv` / `data/stores.js` in the
exact order and format of `tools/build-data.mjs`, and `data/chains.js` (with the `MT_OSM_RULES` block) in
the format of `tools/merge.mjs`, so saving without edits leaves them byte-identical. The in-app OSM scan
classifies with the same rules as the seed merge (`tools/seed/OSM-RULES.md`; `node tools/test/osm-rules.test.mjs`).
The example project lives in `tools/fixtures/demo.mapa.json` and is shipped as
`js/example-project.js` by `node tools/fixtures/build-example.mjs`. Docs: [`SPEC.md`](SPEC.md), [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md),
[`docs/TEST-REPORT.md`](docs/TEST-REPORT.md).

## Coming next

**Cannibalization analysis** (phase 2): today each slide can carry 500 m / 1 km / custom radius
circles with own-vs-competitor counts and an Excel export. Phase 2 extends this to every store:
nearest competitor per store, overlap matrix within a chain, density heat map and catchment
comparison between chains (design notes in `docs/ARCHITECTURE.md` §8).
