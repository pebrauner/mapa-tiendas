/* js/theme.js — MT.theme: every look-and-feel constant of the slide, map and markers.
 *
 * Change the deck's look HERE (SPEC §4.3). Units:
 *   - slide geometry in INCHES on a 13.333 × 7.5 in (16:9) slide — PowerPoint's own units;
 *   - map-frame geometry (markers, leaders, borders, radius strokes) in REFERENCE UNITS: the map
 *     frame is always 1000 units wide (height = 1000 / frame aspect), whatever the pixel size, so
 *     the app preview and every export produce the same layout (SPEC §4.2);
 *   - font sizes in POINTS (pt) as in PowerPoint.
 * Helpers at the bottom convert between them.
 */
(function () {
  'use strict';
  var MT = window.MT;

  var SLIDE_W = 13.333, SLIDE_H = 7.5;
  var FRAME = { x: 0.35, y: 0.85, w: 7.75, h: 6.5 };
  var PANEL_X = 8.55;

  var theme = {
    /* ---- Slide (inches) ---------------------------------------------------------------- */
    slide: {
      width: SLIDE_W, height: SLIDE_H, aspect: SLIDE_W / SLIDE_H,
      background: '#FFFFFF',
      // Left area behind title + map (the panel covers the rest).
      leftArea: { x: 0, y: 0, w: PANEL_X, h: SLIDE_H, color: '#F3F4F6' },
      // Optional decoration of the left area (a corporate template's leaf / swirls): an image data
      // URI drawn over the left-area colour, under the title and the map, in the preview, the PNG
      // slide and the PPTX — {src: 'data:image/png;base64,…', x, y, w, h} in inches (default: the
      // whole left area). null = a plain left area (the map is usually pasted into the user's own
      // template, which brings its own decoration).
      decoration: null,
    },

    title: {
      x: FRAME.x, y: 0.06, w: FRAME.w, h: 0.48,
      font: 'Calibri', sizePt: 24, bold: true, color: '#000000', align: 'center',
    },

    // "(Miraflores, San Borja, San Isidro, Surquillo)  Peso: 15.8%"
    subtitle: {
      x: FRAME.x, y: 0.50, w: FRAME.w, h: 0.30,
      font: 'Calibri', sizePt: 12, minSizePt: 9, maxLines: 2, color: '#6B7280', align: 'center',
      pesoLabelColor: '#6B7280',
      peso: { color: '#1F3864', bold: true, underline: true },
      gap: '  ', // between the districts part and "Peso:"
    },

    mapFrame: {
      x: FRAME.x, y: FRAME.y, w: FRAME.w, h: FRAME.h,
      aspect: FRAME.w / FRAME.h,
      background: '#EEF0F2',         // shown while tiles load / outside tiles
      border: { color: '#D1D5DB', widthPt: 0 }, // 0 = no frame border (as in the reference deck)
    },

    panel: {
      x: PANEL_X, y: 0, w: SLIDE_W - PANEL_X, h: SLIDE_H,
      gradient: { from: '#D42A4C', to: '#8E1631', angleDeg: 160 }, // CSS-style angle, top-left → bottom-right
      // Large faint translucent circles (panel-local inches; alpha of white).
      circles: [
        { cx: 0.55, cy: 1.35, r: 2.05, alpha: 0.07 },
        { cx: 4.35, cy: 2.65, r: 2.35, alpha: 0.06 },
        { cx: 1.30, cy: 6.65, r: 1.70, alpha: 0.07 },
        { cx: 4.70, cy: 7.20, r: 1.25, alpha: 0.05 },
      ],
    },

    legend: {
      heading: { text: 'Tiendas', sizePt: 18, bold: true, color: '#FFFFFF' },
      row: { sizePt: 16, minSizePt: 11, bold: true, color: '#FFFFFF', uppercase: true, heightIn: 0.47 },
      icon: { sizeIn: 0.30, gapIn: 0.16 },      // marker icon diameter and gap before the text
      showCount: true,                             // "PLAZA VEA (6)"
      // Block is centred vertically in the panel; columns kick in above maxRowsPerColumn.
      area: { x: PANEL_X + 0.45, y: 0.55, w: SLIDE_W - PANEL_X - 0.75, h: SLIDE_H - 1.1 },
      maxRowsPerColumn: 11,
      columnGapIn: 0.25,
      headingGapIn: 0.12,
      // Key under the legend when the map groups nearby stores of one chain ("×4" logos): what the
      // count and the small dots mean. Slide text (Spanish), lighter than the rows.
      footnote: { grouped: '×N = N tiendas cercanas  ·  • = ubicación exacta', sizePt: 10.5, minSizePt: 8, color: '#F7D6DD', gapIn: 0.14 },
    },

    /* ---- Map frame (reference units, frame width = 1000) --------------------------------- */
    frame: {
      refWidth: 1000,
      refHeight: 1000 / (FRAME.w / FRAME.h),     // ≈ 838.7
      aspect: FRAME.w / FRAME.h,
      padding: 60,                               // fit-bounds padding so edge markers stay inside
    },

    marker: {
      defaults: { style: 'badge', size: 1.0, minSize: 0.6, maxSize: 1.6 },
      styles: ['badge', 'card', 'dot', 'number'],
      // Uniform logo badge: same-size circle, logo inside, ring in brand colour.
      badge: { diameter: 46, ring: 3.5, background: '#FFFFFF', logoInset: 0, shadow: { blur: 4, offsetY: 1, color: 'rgba(17,24,39,0.28)' } },
      // Natural-shape logo on a rounded white card.
      card: { height: 30, maxWidth: 104, padding: 5, radius: 6, background: '#FFFFFF', borderWidth: 1.5, shadow: { blur: 4, offsetY: 1, color: 'rgba(17,24,39,0.25)' } },
      // Brand-colour dots (logos only in the legend).
      dot: { radius: 7.5, stroke: '#FFFFFF', strokeWidth: 2 },
      // Numbered pins + store table slide.
      number: { diameter: 26, fontSize: 13, color: '#FFFFFF', stroke: '#FFFFFF', strokeWidth: 2 },
      // Exact-location dot under each marker. Dots of stores at (almost) the same spot — several
      // shops in one mall — are spread apart: centres at least `spread.sep` radii apart, each dot
      // moving at most `spread.max` radii from its store, so every chain's dot shows.
      anchorDot: { radius: 3.5, stroke: '#FFFFFF', strokeWidth: 1.5, spread: { sep: 1.7, max: 1 } },
      // Spokes of a grouped logo ("×4"): a faint line in the chain's ring colour from the logo to
      // each of its stores' dots (the leader goes to one of them), so every dot shows which logo
      // it belongs to. Width in reference units.
      spoke: { width: 0.75, alpha: 0.5 },
      // Default placement: directly above the dot with a short stem.
      stem: 9,
      // Leader line; `halo` is a white casing drawn under it, so a leader that has to cross a
      // map label (or another leader) never strikes through the text.
      leader: { color: '#374151', width: 1.2, alpha: 0.75, halo: { color: '#FFFFFF', width: 3.4, alpha: 0.9 } },
      // Declutter: candidate rings (distance from anchor, in marker diameters) × 16 angles.
      // maxLeader caps how far a badge/card may move from its store (leader length, in marker
      // diameters): a store with no free spot that close is drawn as a small dot in its ring colour
      // instead of a logo at the end of a long line (legend counts are unchanged).
      declutter: {
        rings: [0, 0.6, 1.2, 1.9, 2.7, 3.6], angles: 16, minGap: 3, passes: 3, maxLeader: 2.6,
        // Same-chain grouping (badge/card): stores of ONE chain whose dots are all within `radius`
        // marker sizes of each other merge into one logo with a count pip ("×4") above their dots;
        // every store keeps its dot and its count in the legend. Per map, mapCfg.groupNearby:
        // 'auto' (default), true or false. 'auto' turns it on when a first layout is crowded — from
        // autoMinStores stores up, more than autoLongShare of the logos end a leader longer than
        // autoLongRatio marker sizes away (or find no room at all), or more than autoDisplacedShare
        // of them had to leave their default spot above the store. While the grouped layout is
        // still crowded by the same measure, the radius grows by radiusStep up to radiusMax.
        // autoSize: when 'auto' turns grouping on (a crowded map), the logos are also drawn at
        // this share of the map's marker size (shorter leaders, fewer knots); legend icons and
        // store dots keep their size. 1 = never.
        aggregate: { radius: 1.2, radiusStep: 0.6, radiusMax: 2.4, minCount: 2, autoMinStores: 12, autoLongRatio: 1.5, autoLongShare: 0.25, autoDisplacedShare: 0.7, autoSize: 0.85 },
      },
      // Count pip of a grouped logo: white text on the chain's ring colour, white outline, at the
      // top-right of the marker (`at` = distance of its centre from the marker centre, in radii,
      // along the 45° line; cards: the top-right corner).
      countPip: { diameter: 17, fontSize: 11, prefix: '×', stroke: '#FFFFFF', strokeWidth: 1.5, at: 0.98 },
      // A store whose logo did not fit (see declutter.maxLeader): dot diameter in reference units.
      collapsed: { radius: 6, stroke: '#FFFFFF', strokeWidth: 1.75 },
    },

    borders: { color: '#1F3864', width: 2, alpha: 0.85, dash: null, fill: 'rgba(31,56,100,0.035)' },

    radius: {
      stroke: '#C62842', width: 2, dash: [7, 5], fill: 'rgba(212,42,76,0.09)',
      presets: [500, 1000],                       // meters; custom allowed
      label: { sizePt: 9, color: '#8E1631' },
    },

    attribution: {
      text: '© OpenStreetMap contributors · © OpenMapTiles · OpenFreeMap',
      fontSize: 9, color: '#4B5563', background: 'rgba(255,255,255,0.78)', padding: 3, position: 'bottom-right',
      // PowerPoint text box: a real point size (the reference-unit size is ≈ 5 pt, which PowerPoint
      // renders with uneven glyph spacing) on a lighter box (a 78 % white box reads as a pale strip).
      pptx: { sizePt: 6, background: 'rgba(255,255,255,0.5)' },
    },

    /* ---- Colours, fonts, basemap ----------------------------------------------------------- */
    colors: {
      crimson: '#D42A4C', crimsonDark: '#8E1631', accent: '#C62842', navy: '#1F3864',
      text: '#111827', textMuted: '#6B7280', unknownChain: '#6B7280',
      white: '#FFFFFF', black: '#000000',
    },

    fonts: {
      slide: 'Calibri',                                         // PPTX font face
      slideCss: "Calibri, Carlito, 'Segoe UI', Arial, sans-serif", // canvas / HTML slide (Carlito is vendored)
      ui: "'Instrument Sans', 'Segoe UI', system-ui, sans-serif",
      display: "'Bricolage Grotesque', 'Instrument Sans', 'Segoe UI', sans-serif",
      mapLabels: ['Noto Sans Regular'],                         // OpenFreeMap glyph stack
      mapLabelsBold: ['Noto Sans Bold'],
    },

    basemap: {
      style: 'https://tiles.openfreemap.org/styles/positron',
      // Positron symbol layers whose text-field uses name_en — M1 swaps them to Spanish
      // (see docs/TECH-NOTES.md §1.3).
      labelLayers: ['waterway_line_label', 'water_name_point_label', 'water_name_line_label',
        'highway-name-path', 'highway-name-minor', 'highway-name-major', 'airport',
        'label_other', 'label_village', 'label_town', 'label_state', 'label_city',
        'label_city_capital', 'label_country_3', 'label_country_2', 'label_country_1'],
      spanishTextField: ['coalesce', ['get', 'name:es'], ['get', 'name']],
      maxCanvasSize: 4096,
      // Neighbourhood / district names ("label_other", italic upper case) — and the selected
      // districts' names the app writes itself when the basemap has none at that zoom: text size
      // in basemap px by zoom ([zoom, px] stops), colour and letter spacing.
      districtLabel: { size: [[8, 11], [12, 12.5], [15, 14]], color: '#3F3F46', letterSpacing: 0.06 },
      // Main avenue names (motorway / trunk / primary) from this basemap zoom on (positron: 12.2),
      // and their text size ([zoom, px] stops).
      majorRoadNames: { minzoom: 11.5, size: [[11.5, 11.5], [13, 12.5], [14, 13.5]] },
      // The main road network (motorway / trunk / primary) in a faint warm tone with a darker
      // casing, so it reads at a glance among the white side streets; `subtle` = the thin line
      // positron draws for main roads below zoom 11.
      mainRoads: { fill: '#FBEFD9', casing: '#E4CDA4', subtle: '#E2CBA2' },
      // Route shields (1S, PE-1N) of motorways and trunk roads from this basemap zoom on
      // (positron: 11).
      shieldMinzoom: 10,
    },

    export: {
      mapScales: [2, 3, 4], mapScale: 3,
      slideWidths: [3840, 1920], slideWidth: 3840,
    },
  };

  /* ---- Unit helpers -------------------------------------------------------------------- */
  /** Inches → pixels for a slide rendered `slidePx` pixels wide. */
  theme.in2px = function (inches, slidePx) { return inches * slidePx / SLIDE_W; };
  /** Points → pixels for a slide rendered `slidePx` pixels wide. */
  theme.pt2px = function (pt, slidePx) { return (pt / 72) * slidePx / SLIDE_W; };
  /** Reference units (map frame) → inches on the slide. */
  theme.ref2in = function (units) { return units * FRAME.w / 1000; };
  /** Inches on the slide → reference units. */
  theme.in2ref = function (inches) { return inches * 1000 / FRAME.w; };
  /** Reference units → pixels for a map frame `framePx` pixels wide. */
  theme.ref2px = function (units, framePx) { return units * framePx / 1000; };
  /** Points → reference units (text drawn inside the map frame, e.g. radius labels). */
  theme.pt2ref = function (pt) { return theme.in2ref(pt / 72); };

  /** Marker dimensions in reference units for a style and size multiplier. */
  theme.markerDims = function (style, size) {
    var m = theme.marker, k = MT.util.clamp(+size || 1, m.defaults.minSize, m.defaults.maxSize);
    switch (style) {
      case 'card': return { w: m.card.maxWidth * k, h: m.card.height * k, k: k };
      case 'dot': return { w: 2 * m.dot.radius * k, h: 2 * m.dot.radius * k, k: k };
      case 'number': return { w: m.number.diameter * k, h: m.number.diameter * k, k: k };
      default: return { w: m.badge.diameter * k, h: m.badge.diameter * k, k: k };
    }
  };

  /** CSS linear-gradient for the legend panel (HTML slide preview). */
  theme.panelCss = function () {
    var g = theme.panel.gradient;
    return 'linear-gradient(' + g.angleDeg + 'deg, ' + g.from + ' 0%, ' + g.to + ' 100%)';
  };

  MT.theme = theme;
})();
