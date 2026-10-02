/* js/legend.js — MT.legend: the legend model ("PLAZA VEA (6)"). Module M1.
 *
 * CONTRACT (docs/ARCHITECTURE.md §6.1, SPEC §1 "Legend"):
 *   MT.legend.items(mapCfg, layout?) → [{chainId, label, name, count, text}]
 *     Built ONLY from what is visible on the map: the layout items inside the frame (the map's own
 *     MT.layout.compute result when no layout is passed). label = chain.legendName (fallback: name
 *     upper-cased); text = label + " (n)" when MT.theme.legend.showCount. Sorted by
 *     mapCfg.legendSort: 'alpha' (MT.util.compare) or 'count' (desc, then alpha). No zero rows.
 *     rows.footnote (non-enumerable): theme legend.footnote.grouped when the layout has same-chain
 *     group logos ("×4"), else null — MT.slide.layout puts it under the rows.
 *     rows.distances (non-enumerable, analysis slides only — SPEC §6.3, else null):
 *       {heading: "Distancias a Plaza Vea Miraflores", items: [{storeId, chainId, name, short, text,
 *       meters, rank, approx, toVerify}]} — the analysis' `listTop` nearest stores of the slide (those
 *       drawn on the map when the layout knows its stores), `text` = distance (es-PE slide text,
 *       distance()), "≈ 750 m" for a store whose location is approximate or still "por verificar"
 *       (the speaker notes say which).
 *   MT.legend.footnote(layout) → string | null
 *   MT.legend.distances(mapCfg, layout?) → the distance list above, or null
 *   MT.legend.distance(meters) → "450 m", "1.5 km", "12 km" — slide text in Spanish (Peru): the deck
 *     is Spanish whatever the UI language (Intl 'es-PE': a point as the decimal separator). It is
 *     MT.i18n.formatDistance, the one distance text of the app (UI, slides, exports, Excel).
 *   MT.legend.ringLabel(meters) → "500 m", "1 km", "1.25 km" — a distance the user typed (ring pills,
 *     "Anillo …" shapes, notes): its exact value (MT.i18n.formatDistanceExact).
 *   MT.legend.shortName(store) → the store's name without its chain's name ("Plaza Vea Angamos" →
 *     "Angamos"; the chain icon beside it says the chain), or the whole name.
 */
(function () {
  'use strict';
  const MT = window.MT, U = MT.util;

  function items(mapCfg, layout) {
    if (!mapCfg) return [];
    const list = layout || MT.layout.compute(mapCfg);
    const counts = {};
    list.forEach((it) => { counts[it.chainId] = (counts[it.chainId] || 0) + 1; });
    const showCount = MT.theme.legend.showCount !== false;
    const upper = MT.theme.legend.row.uppercase !== false;
    const rows = Object.keys(counts).map((id) => {
      const c = MT.data.chain(id);
      let label = String(c.legendName || c.name || id).trim() || id;
      if (upper) label = label.toLocaleUpperCase('es');
      return { chainId: id, label: label, name: c.name, count: counts[id], text: showCount ? label + ' (' + counts[id] + ')' : label };
    });
    const byAlpha = (a, b) => U.compare(a.label, b.label) || (a.chainId < b.chainId ? -1 : 1);
    rows.sort(mapCfg.legendSort === 'count' ? (a, b) => b.count - a.count || byAlpha(a, b) : byAlpha);
    // The map groups nearby stores of one chain into "×N" logos: the legend explains the count and
    // the small dots (non-enumerable: the rows stay plain rows).
    Object.defineProperty(rows, 'footnote', { value: footnote(list), enumerable: false });
    // An analysis slide lists the nearest stores under the chain legend.
    Object.defineProperty(rows, 'distances', { value: mapCfg.analysis ? distances(mapCfg, list) : null, enumerable: false });
    return rows;
  }

  /** Key text under the legend for a layout (null when no logo stands for several stores). */
  function footnote(layout) {
    const st = layout && layout.stats, f = MT.theme.legend.footnote;
    return f && f.grouped && st && st.grouping && st.grouping.groups > 0 ? f.grouped : null;
  }

  /* ---- Analysis slides: "Distancias a <referencia>" ----------------------------------------------- */
  /** A measured distance as slide text: "450 m", "1.5 km" (one decimal below 10 km), "12 km" (= MT.i18n.formatDistance). */
  function distance(meters) { return MT.i18n.formatDistance(meters); }
  /** A distance the user typed (a ring, the slide's universe): its exact value, "1.25 km" (= MT.i18n.formatDistanceExact). */
  function ringLabel(meters) { return MT.i18n.formatDistanceExact(meters); }
  /** A list row's distance: "≈ 750 m" when the store's location is approximate or still "por verificar". */
  function rowText(r) { return (r.flags && (r.flags.approx || r.flags.toVerify) ? '≈ ' : '') + distance(r.meters); }

  /** The store's name without its chain's name in front (the icon beside it shows the chain). */
  function shortName(store) {
    if (!store) return '';
    const full = String(store.name || '').trim();
    const c = MT.data.chain(store.chain);
    const fold = (s) => U.normalize(s).replace(/\s+/g, '');
    for (const prefix of [c.name, c.legendName]) {
      if (!prefix) continue;
      const p = fold(prefix);
      if (!p) continue;
      // Walk the name until its folded letters cover the chain's name, then cut there.
      let acc = '';
      for (let i = 0; i < full.length; i++) {
        acc = fold(full.slice(0, i + 1));
        if (acc.length > p.length) break;
        if (acc === p && /[\s\-–—:·,.+]|$/.test(full.charAt(i + 1) || '')) {
          const rest = full.slice(i + 1).replace(/^[\s\-–—:·,.+]+/, '').trim();
          if (rest) return rest;
          break;
        }
      }
    }
    return full || store.id;
  }

  /** The analysis' distance list for a slide, or null (see the contract above). */
  function distances(mapCfg, layout) {
    const g = MT.layout.analysis && MT.layout.analysis(mapCfg);
    if (!g) return null;
    const a = mapCfg.analysis, top = Math.max(0, Math.floor(+a.listTop) || 0);
    if (!top) return null;
    // The stores drawn on the map (a layout of store items), when the caller's layout knows them.
    const known = layout && layout.length && layout.every((it) => it.storeId);
    const on = known ? new Set(layout.map((it) => it.storeId)) : null;
    const rows = (g.rows || []).filter((r) => !on || on.has(r.store.id)).slice(0, top);
    const L = MT.theme.analysis.list || {};
    const ref = g.label || '';
    const point = g.ref.type === 'point' && !(mapCfg.analysis.ref && mapCfg.analysis.ref.label);
    const heading = point ? (L.headingPoint || 'Distancias al punto elegido') : String(L.heading || 'Distancias a {ref}').replace('{ref}', ref);
    return {
      heading: heading,
      items: rows.map((r) => ({ storeId: r.store.id, chainId: r.store.chain, name: r.store.name || r.store.id, short: shortName(r.store),
        text: rowText(r), meters: r.meters, rank: r.rank, approx: !!(r.flags && r.flags.approx), toVerify: !!(r.flags && r.flags.toVerify) })),
    };
  }

  MT.legend = { items: items, footnote: footnote, distances: distances, distance: distance, ringLabel: ringLabel, shortName: shortName };
})();
