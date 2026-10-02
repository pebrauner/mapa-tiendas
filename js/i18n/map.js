/* js/i18n/map.js — strings of module M1 (map view, slide preview, legend, markers, radius, render).
 * Key namespace: 'map.*'. ES and EN together, Spanish first (Peruvian business wording).
 * Slide CONTENT that ends up in exports ("Tiendas", "Peso:", legend names, "1 km") is Spanish data
 * from MT.theme / the project, not UI text — it is not translated here.
 */
(function () {
  'use strict';
  MT.i18n.add('es', {
    map: {
      slide: { aria: 'Vista previa de la lámina', titlePlaceholder: 'Título del mapa' },
      legend: { aria: 'Leyenda de tiendas' },
      controls: 'Controles del mapa',
      canvasAria: 'Mapa: arrastra para mover el encuadre, usa la rueda o las teclas + y − para acercar o alejar',
      zoomIn: 'Acercar',
      zoomOut: 'Alejar',
      resetView: 'Volver al encuadre automático',
      resetLayout: 'Restablecer la ubicación de los logos',
      loading: 'Cargando mapa…',
      chip: {
        manualView: 'Encuadre manual',
        moved: { one: '{n} logo movido', other: '{n} logos movidos' },
        overlaps: { one: '{n} logo se superpone', other: '{n} logos se superponen' },
        overlapsHint: 'Hay demasiados logos juntos para este encuadre. Prueba un tamaño de marcador menor, acerca el mapa o usa el estilo de puntos.',
        collapsed: { one: '{n} tienda como punto', other: '{n} tiendas como puntos' },
        collapsedHint: 'No hay espacio para su logo cerca de la tienda, así que se dibuja un punto del color de su cadena (cuenta igual en la leyenda). Achica los logos o acerca el mapa para ver más logos; también puedes arrastrar el punto para mostrar su logo.',
      },
      marker: {
        aria: '{name} ({chain})',
        hint: 'Arrastra para mover · doble clic para restablecer · Re Pág / Av Pág: tienda anterior o siguiente',
        group: { one: 'Este logo representa {n} tienda de {chain}', other: 'Este logo agrupa {n} tiendas cercanas de {chain}' },
        reference: 'Referencia del análisis de distancias',
      },
      notice: {
        noMap: { title: 'No hay un mapa seleccionado', text: 'Crea un mapa o elige uno de la lista.' },
        noDistricts: { title: 'Elige los distritos', text: 'Agrega uno o más distritos para armar el mapa.', action: 'Elegir distritos' },
        noStores: { title: 'No hay tiendas para mostrar', text: 'Ninguna tienda de las cadenas activas cae en estos distritos.' },
        noStoresNear: { title: 'No hay tiendas cerca de la referencia', text: 'Ninguna tienda de las cadenas activas está a menos de {d} de la referencia.' },
        noRef: { title: 'No se encuentra la referencia', text: 'La tienda o el punto de referencia de este análisis ya no está en la base. Edítalo en Análisis o quita el análisis de la lámina.' },
        outOfView: { title: 'Las tiendas quedan fuera del encuadre', text: 'Vuelve al encuadre automático o aleja el mapa para verlas.' },
        noData: { title: 'Falta la base de tiendas', text: 'No se pudo cargar data/stores.js. Abre la aplicación desde la carpeta completa del proyecto.' },
        basemapError: { title: 'No se pudo cargar el mapa base', text: 'Revisa tu conexión a internet; se volverá a intentar solo en cuanto haya conexión. Las tiendas y la leyenda siguen disponibles.' },
        webglError: { title: 'Este navegador no puede dibujar el mapa', text: 'Activa la aceleración por hardware (WebGL) en Chrome o Edge y vuelve a abrir la aplicación. Las tiendas y la leyenda siguen disponibles.' },
      },
      // MapLibre's built-in controls (MT.i18n.mapLocale).
      locale: {
        zoomIn: 'Acercar', zoomOut: 'Alejar', resetBearing: 'Restablecer orientación',
        toggleAttribution: 'Mostrar u ocultar la atribución', mapFeedback: 'Sugerir una mejora al mapa',
        fullscreenEnter: 'Pantalla completa', fullscreenExit: 'Salir de pantalla completa',
        mapTitle: 'Mapa', markerTitle: 'Ubicación', popupClose: 'Cerrar',
        coopWindows: 'Usa Ctrl + rueda del mouse para acercar o alejar el mapa', coopMac: 'Usa ⌘ + rueda del mouse para acercar o alejar el mapa',
        coopMobile: 'Usa dos dedos para mover el mapa',
      },
      error: {
        unavailable: 'No se pudo cargar el mapa base para la exportación. Revisa tu conexión a internet e inténtalo de nuevo.',
        timeout: 'El mapa base tardó demasiado en cargar. Inténtalo de nuevo en unos segundos.',
        webgl: 'Este navegador no puede dibujar mapas (WebGL desactivado). Activa la aceleración por hardware en la configuración de Chrome o Edge y vuelve a abrir la aplicación; si lo bloquea tu empresa, pide al área de sistemas que habilite WebGL.',
      },
      radius: {
        col: {
          center: 'Tienda central', centerChain: 'Cadena de la tienda central', radius: 'Radio (m)',
          store: 'Tienda dentro del radio', chain: 'Cadena', relation: 'Relación', distance: 'Distancia (m)',
          address: 'Dirección', district: 'Distrito',
        },
        same: 'Misma cadena',
        competitor: 'Competencia',
        none: 'Sin tiendas dentro del radio',
      },
    },
  });
  MT.i18n.add('en', {
    map: {
      slide: { aria: 'Slide preview', titlePlaceholder: 'Map title' },
      legend: { aria: 'Store legend' },
      controls: 'Map controls',
      canvasAria: 'Map: drag to move the framing, use the wheel or the + and − keys to zoom',
      zoomIn: 'Zoom in',
      zoomOut: 'Zoom out',
      resetView: 'Back to automatic framing',
      resetLayout: 'Reset logo positions',
      loading: 'Loading map…',
      chip: {
        manualView: 'Manual framing',
        moved: { one: '{n} logo moved', other: '{n} logos moved' },
        overlaps: { one: '{n} logo overlaps', other: '{n} logos overlap' },
        overlapsHint: 'Too many logos close together for this framing. Try a smaller marker size, zoom in, or use the dot style.',
        collapsed: { one: '{n} store as a dot', other: '{n} stores as dots' },
        collapsedHint: 'There is no room for its logo near the store, so a dot in its chain colour is drawn instead (it still counts in the legend). Make the logos smaller or zoom in to see more logos; you can also drag the dot to show its logo.',
      },
      marker: {
        aria: '{name} ({chain})',
        hint: 'Drag to move · double-click to reset · Page Up / Page Down: previous or next store',
        group: { one: 'This logo stands for {n} {chain} store', other: 'This logo groups {n} nearby {chain} stores' },
        reference: 'Reference of the distance analysis',
      },
      notice: {
        noMap: { title: 'No map selected', text: 'Create a map or pick one from the list.' },
        noDistricts: { title: 'Choose the districts', text: 'Add one or more districts to build the map.', action: 'Choose districts' },
        noStores: { title: 'No stores to show', text: 'No store of the active chains falls inside these districts.' },
        noStoresNear: { title: 'No stores near the reference', text: 'No store of the active chains is within {d} of the reference.' },
        noRef: { title: 'The reference cannot be found', text: 'The reference store or point of this analysis is no longer in the database. Edit it in Analysis or remove the analysis from the slide.' },
        outOfView: { title: 'The stores are outside the framing', text: 'Go back to automatic framing or zoom out to see them.' },
        noData: { title: 'The store database is missing', text: 'data/stores.js could not be loaded. Open the app from the complete project folder.' },
        basemapError: { title: 'The base map could not be loaded', text: 'Check your internet connection; it will retry by itself as soon as you are online. Stores and the legend are still available.' },
        webglError: { title: 'This browser cannot draw the map', text: 'Turn on hardware acceleration (WebGL) in Chrome or Edge and reopen the app. Stores and the legend are still available.' },
      },
      locale: {
        zoomIn: 'Zoom in', zoomOut: 'Zoom out', resetBearing: 'Reset bearing to north',
        toggleAttribution: 'Toggle attribution', mapFeedback: 'Map feedback',
        fullscreenEnter: 'Enter fullscreen', fullscreenExit: 'Exit fullscreen',
        mapTitle: 'Map', markerTitle: 'Map marker', popupClose: 'Close popup',
        coopWindows: 'Use Ctrl + scroll to zoom the map', coopMac: 'Use ⌘ + scroll to zoom the map',
        coopMobile: 'Use two fingers to move the map',
      },
      error: {
        unavailable: 'The base map could not be loaded for the export. Check your internet connection and try again.',
        timeout: 'The base map took too long to load. Please try again in a few seconds.',
        webgl: 'This browser cannot draw maps (WebGL is off). Turn on hardware acceleration in the Chrome or Edge settings and reopen the app; if your company blocks it, ask IT to enable WebGL.',
      },
      radius: {
        col: {
          center: 'Centre store', centerChain: 'Centre store chain', radius: 'Radius (m)',
          store: 'Store within the radius', chain: 'Chain', relation: 'Relation', distance: 'Distance (m)',
          address: 'Address', district: 'District',
        },
        same: 'Same chain',
        competitor: 'Competitor',
        none: 'No stores within the radius',
      },
    },
  });
})();
