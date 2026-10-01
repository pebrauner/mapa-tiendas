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
 *   MT.legend.footnote(layout) → string | null
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
    return rows;
  }

  /** Key text under the legend for a layout (null when no logo stands for several stores). */
  function footnote(layout) {
    const st = layout && layout.stats, f = MT.theme.legend.footnote;
    return f && f.grouped && st && st.grouping && st.grouping.groups > 0 ? f.grouped : null;
  }

  MT.legend = { items: items, footnote: footnote };
})();
