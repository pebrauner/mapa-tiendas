/* js/slide.js — MT.slide: the live 16:9 slide preview (HTML) and the slide geometry shared with the
 * canvas export (MT.render.slideCanvas). Module M1.
 *
 * Replicates the deck's red layout (SPEC §4.3): light-grey left area, bold title centred over the
 * map, grey subtitle "(districts)  Peso: 15.8%" (value bold, underlined, navy), the map frame
 * (hosts MT.mapview) and the crimson gradient panel with faint circles, "Tiendas" and the legend.
 * Every size/colour/font comes from MT.theme; text is laid out ONCE here (line breaks, shrink to fit,
 * legend columns) with canvas text metrics, and both the DOM preview and the PNG/PPTX exports use
 * that result — so the preview is what gets exported.
 *
 * CONTRACT (docs/ARCHITECTURE.md §6.1):
 *   MT.slide.mount(el)        build the slide inside `el`; it scales to the available space
 *   MT.slide.render(mapCfg)   update everything for a map config (null → empty state)
 *   MT.slide.element()        the slide root element (or null)
 * Extras: layout(mapCfg, slideWidthPx, legendRows?) → geometry in slide px (title, subtitle, frame,
 *   panel, legend) — used by MT.render; legendLayout(rows, W, style) (an analysis slide's rows carry
   `distances`: the legend then also holds `dist` — "Distancias a <referencia>", the nearest stores —
   laid out by analysisLegend's space rule, ARCHITECTURE §8.4); font(weight, px); metrics();
 *   current() → the map config on screen. Event: 'slide:rendered' {id, legend}.
 */
(function () {
  'use strict';
  const MT = window.MT, U = MT.util, h = U.h;
  const T = () => MT.theme;

  /* ---- Text metrics (canvas; the DOM uses the same fonts so widths match) --------------------- */
  let mctx = null;
  function ctx2d() { return mctx || (mctx = document.createElement('canvas').getContext('2d')); }
  function font(weight, px) { return (weight === 'bold' || weight === 700 ? '700 ' : '400 ') + px + 'px ' + T().fonts.slideCss; }
  function width(text, weight, px) { const c = ctx2d(); c.font = font(weight, px); return c.measureText(text).width; }
  /** Font ascent/descent (px) — the CSS line box uses the same metrics, so baselines match. */
  function metrics(weight, px) {
    const c = ctx2d(); c.font = font(weight, px);
    const m = c.measureText('Hg');
    const a = m.fontBoundingBoxAscent, d = m.fontBoundingBoxDescent;
    return { ascent: isFinite(a) ? a : px * 0.75, descent: isFinite(d) ? d : px * 0.25 };
  }
  /** Baseline y of text vertically centred in a line box [top, top+lineH] (CSS half-leading model). */
  function baseline(top, lineH, weight, px) {
    const m = metrics(weight, px);
    return top + (lineH - (m.ascent + m.descent)) / 2 + m.ascent;
  }
  function ellipsize(text, weight, px, maxW) {
    if (width(text, weight, px) <= maxW + 0.5) return text;
    let lo = 0, hi = text.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (width(text.slice(0, mid).trimEnd() + '…', weight, px) <= maxW) lo = mid; else hi = mid - 1;
    }
    return text.slice(0, lo).trimEnd() + '…';
  }

  /* ---- Geometry ---------------------------------------------------------------------------------- */
  function rectIn(o, k) { return { x: o.x * k, y: o.y * k, w: o.w * k, h: o.h * k }; }

  function titleLayout(text, box, W) {
    const t = T().title;
    const maxPx = T().pt2px(t.sizePt, W), minPx = T().pt2px(Math.min(t.sizePt, 16), W);
    let px = maxPx;
    text = String(text || '').trim();
    while (px > minPx && width(text, 'bold', px) > box.w) px -= maxPx * 0.02;
    px = Math.max(px, minPx);
    const shown = ellipsize(text, 'bold', px, box.w);
    return { text: shown, full: text, fontPx: px, x: box.x, y: box.y, w: box.w, h: box.h, baseline: baseline(box.y, box.h, 'bold', px), color: t.color };
  }

  /** Subtitle runs: (districts)  Peso: <value>. Kinds: text | label | peso. */
  function subtitleUnits(mapCfg) {
    const sub = MT.data.subtitleFor(mapCfg) || '';
    const peso = String((mapCfg && mapCfg.peso) || '').trim();
    // Wrap units: one per district ("San Juan de Lurigancho," stays whole, comma attached), so a
    // two-line subtitle never splits a district name; words only when one district is too wide.
    const words = sub.split(/(?<=,)\s+/).map((w) => w.trim()).filter(Boolean).map((w) => ({ text: w, kind: 'text' }));
    const pesoUnit = peso ? [{ text: (T().subtitle.pesoLabel || 'Peso:') + ' ', kind: 'label' }, { text: peso, kind: 'peso' }] : null;
    return { words: words, peso: pesoUnit };
  }
  function runsWidth(runs, px) {
    return runs.reduce((s, r) => s + width(r.text, r.kind === 'peso' ? 'bold' : 'normal', px), 0);
  }
  function joinWords(words) { return words.length ? [{ text: words.map((w) => w.text).join(' '), kind: 'text' }] : []; }

  function subtitleLayout(mapCfg, box, frameY, W) {
    const s = T().subtitle;
    const u = subtitleUnits(mapCfg);
    const gap = s.gap || '  ';
    const availH = Math.max(box.h, frameY - box.y - W * 0.002);
    const maxPx = T().pt2px(s.sizePt, W), minPx = T().pt2px(s.minSizePt, W);
    const oneLine = () => {
      const runs = joinWords(u.words);
      if (u.peso) { if (runs.length) runs.push({ text: gap, kind: 'text' }); runs.push.apply(runs, u.peso); }
      return [runs];
    };
    let lines = null, px = maxPx;
    if (!u.words.length && !u.peso) return { lines: [], fontPx: maxPx, lineH: maxPx * 1.2, x: box.x, y: box.y, w: box.w };
    for (px = maxPx; px >= minPx - 1e-6; px -= maxPx * 0.03) {
      const lineH = px * 1.2;
      const one = oneLine();
      if (runsWidth(one[0], px) <= box.w && lineH <= availH + 0.5) { lines = one; break; }
      if ((s.maxLines || 2) < 2 || 2 * lineH > availH + 0.5) continue;
      // Two lines: districts on the first, "Peso: x" on the second (as in the reference deck) …
      const first = joinWords(u.words);
      if (u.peso && runsWidth(first, px) <= box.w && runsWidth(u.peso, px) <= box.w) { lines = [first, u.peso.slice()]; break; }
      // … or greedy wrap by district with "Peso: x" kept together (a district wider than the
      // whole line falls back to its words).
      const tokens = [];
      u.words.forEach((w) => {
        if (runsWidth([w], px) <= box.w || !/\s/.test(w.text)) tokens.push([w]);
        else w.text.split(/\s+/).forEach((x) => tokens.push([{ text: x, kind: 'text' }]));
      });
      if (u.peso) tokens.push(u.peso);
      const out = [[]];
      let ok = true;
      for (const tk of tokens) {
        const cur = out[out.length - 1];
        const sep = tk === u.peso ? gap : ' ';
        const trial = cur.concat(cur.length ? [{ text: sep, kind: 'text' }] : [], tk);
        if (runsWidth(trial, px) <= box.w) { out[out.length - 1] = trial; continue; }
        if (out.length >= 2 || runsWidth(tk, px) > box.w) { ok = false; break; }
        out.push(tk.slice());
      }
      if (ok) { lines = out.map(mergeRuns); break; }
    }
    if (!lines) {
      // Still too long at the minimum size: two lines, the districts ellipsized.
      px = minPx;
      const txt = ellipsize(u.words.map((w) => w.text).join(' '), 'normal', px, box.w);
      lines = u.peso ? [[{ text: txt, kind: 'text' }], u.peso.slice()] : [[{ text: txt, kind: 'text' }]];
      if (2 * px * 1.2 > availH + 0.5 && u.peso) lines = [[{ text: ellipsize(txt, 'normal', px, box.w - runsWidth(u.peso, px) - width(gap, 'normal', px)), kind: 'text' }, { text: gap, kind: 'text' }].concat(u.peso)];
    }
    const lineH = px * 1.2;
    const totalH = lines.length * lineH;
    const top = box.y + Math.max(0, Math.min(box.h, availH) - totalH) / 2 * (lines.length > 1 ? 0 : 1);
    const out = lines.map((runs, i) => {
      const w = runsWidth(runs, px);
      let x = box.x + (box.w - w) / 2;
      const y = top + i * lineH;
      const placed = runs.map((r) => {
        const weight = r.kind === 'peso' ? 'bold' : 'normal';
        const rw = width(r.text, weight, px);
        const o = { text: r.text, kind: r.kind, x: x, w: rw, weight: weight, color: r.kind === 'peso' ? s.peso.color : (r.kind === 'label' ? s.pesoLabelColor : s.color) };
        x += rw;
        return o;
      });
      return { runs: placed, y: y, h: lineH, baseline: baseline(y, lineH, 'normal', px), width: w };
    });
    return { lines: out, fontPx: px, lineH: lineH, x: box.x, y: box.y, w: box.w,
      underline: { offset: px * 0.13, thickness: Math.max(1, px * 0.075) } };
  }
  function mergeRuns(runs) {
    const out = [];
    runs.forEach((r) => {
      const last = out[out.length - 1];
      if (last && last.kind === r.kind) last.text += r.text; else out.push({ text: r.text, kind: r.kind });
    });
    return out;
  }

  /**
   * Legend block in slide px: heading + rows (1–3 columns, shrinking font to fit the panel). An
   * analysis slide's rows carry `distances` (MT.legend): the block then also holds the "Distancias
   * a <referencia>" list (analysisLegend).
   */
  function legendLayout(rows, W, style) {
    const d = rows && rows.distances;
    if (d && d.items && d.items.length) return analysisLegend(rows, W, style, d);
    return legendBlock(rows, W, style);
  }
  /**
   * The chain legend. o (analysis slides only): {area (slide px), top: lay it out from area.y instead
   * of centring it, fit: report how it fitted in `fit` (1 = theme sizes, 2 = below the minimum, 3 =
   * ellipsis)}. Without `o` the result is exactly the v1 legend.
   */
  function legendBlock(rows, W, style, o) {
    const th = T(), L = th.legend, k = W / th.slide.width;
    const st = MT.layout.styleOf(style);
    const area = o && o.area ? o.area : rectIn(L.area, k);
    const n = rows.length;
    const headPx = th.pt2px(L.heading.sizePt, W);
    const headH = headPx * 1.3, headGap = L.headingGapIn * k;
    const colGap = L.columnGapIn * k;
    // Card icons are wider than tall: the icon column is as wide as the widest one, capped so a
    // very wide wordmark shrinks instead of eating the text column.
    const MAX_ICON_ASPECT = 2.3;
    const aspect = {};
    rows.forEach((r) => {
      if (st.kind === 'card') { const d = MT.markers.dims(r.chainId, { kind: 'card', size: 1 }); aspect[r.chainId] = (d.w + 2) / (d.h + 2); } else aspect[r.chainId] = 1;
    });
    const maxAspect = Math.min(MAX_ICON_ASPECT, rows.reduce((m, r) => Math.max(m, aspect[r.chainId]), 1));
    const minF = L.row.minSizePt / L.row.sizePt;
    const texts = rows.map((r) => r.text);
    // Key under the rows (rows.footnote, MT.legend: "×N = N tiendas cercanas · • = ubicación
    // exacta"): one line, shrunk to the panel's width.
    const FN = L.footnote || {}, noteText = rows.footnote ? String(rows.footnote) : '';
    let notePx = 0, noteH = 0, noteGap = 0;
    if (noteText) {
      notePx = th.pt2px(FN.sizePt || 10.5, W);
      const minNote = th.pt2px(FN.minSizePt || 8, W);
      while (notePx > minNote && width(noteText, 'normal', notePx) > area.w) notePx = Math.max(minNote, notePx - notePx * 0.03);
      noteH = notePx * 1.3; noteGap = (FN.gapIn === undefined ? 0.14 : FN.gapIn) * k;
    }
    let best = null;
    const tryFit = (cols, f, force) => {
      const perCol = Math.max(1, Math.ceil(n / cols));
      const colW = (area.w - (cols - 1) * colGap) / cols;
      const fontPx = th.pt2px(L.row.sizePt * f, W);
      const rowH = L.row.heightIn * k * f;
      const iconH = L.icon.sizeIn * k * Math.max(f, 0.8);
      const iconW = iconH * maxAspect;
      const gap = L.icon.gapIn * k * f;
      if (!force && headH + headGap + perCol * rowH + noteGap + noteH > area.h + 0.5) return null;
      const colWidths = [];
      for (let c = 0; c < cols; c++) {
        let mw = 0;
        for (let i = c * perCol; i < Math.min(n, (c + 1) * perCol); i++) mw = Math.max(mw, width(texts[i], 'bold', fontPx));
        if (!force && iconW + gap + mw > colW - 1) return null;   // 1 px safety: DOM text may round up
        colWidths.push(Math.min(colW, iconW + gap + mw));
      }
      return { cols: cols, perCol: perCol, colW: colW, fontPx: fontPx, rowH: rowH, iconH: iconH, iconW: iconW, gap: gap, colWidths: colWidths, f: f };
    };
    const colsFor = (c) => !(c === 1 && n > L.maxRowsPerColumn) && !(c > 1 && n < c * 2);
    let fit = 1;
    // 1) theme sizes: fewest columns at the largest font that fits;
    for (let cols = 1; cols <= 3 && !best; cols++) {
      if (!colsFor(cols)) continue;
      for (let f = 1; f >= minF - 1e-9 && !best; f -= 0.025) best = tryFit(cols, f, false);
    }
    // 2) still too long: go below the minimum size rather than cut a chain name or its count;
    for (let cols = 1; cols <= 3 && !best; cols++) {
      if (!colsFor(cols)) continue;
      for (let f = minF; f >= 0.5 - 1e-9 && !best; f -= 0.025) { best = tryFit(cols, f, false); if (best) fit = 2; }
    }
    // 3) last resort: smallest size, ellipsis.
    if (!best) { best = tryFit(n > L.maxRowsPerColumn * 2 ? 3 : n > L.maxRowsPerColumn ? 2 : 1, 0.5, true); fit = 3; }
    const blockW = best.colWidths.reduce((a, b) => a + b, 0) + (best.cols - 1) * colGap;
    const blockH = headH + headGap + best.perCol * best.rowH + noteGap + noteH;
    const x0 = area.x + Math.max(0, (area.w - Math.max(blockW, width(L.heading.text, 'bold', headPx))) / 2);
    const y0 = o && o.top ? area.y : area.y + Math.max(0, (area.h - blockH) / 2);
    const out = rows.map((r, i) => {
      const c = Math.floor(i / best.perCol), rr = i % best.perCol;
      let x = x0;
      for (let j = 0; j < c; j++) x += best.colWidths[j] + colGap;
      const textMax = best.colW - best.iconW - best.gap;
      const text = ellipsize(r.text, 'bold', best.fontPx, textMax);
      const y = y0 + headH + headGap + rr * best.rowH;
      const iw = Math.min(best.iconW, best.iconH * aspect[r.chainId]), ih = iw / aspect[r.chainId];
      return {
        chainId: r.chainId, text: text, count: r.count,
        x: x, y: y, h: best.rowH,
        icon: { x: x + (best.iconW - iw) / 2, y: y + (best.rowH - ih) / 2, w: iw, h: ih },
        textX: x + best.iconW + best.gap, baseline: baseline(y, best.rowH, 'bold', best.fontPx), fontPx: best.fontPx,
      };
    });
    const headW = Math.max(blockW, width(L.heading.text, 'bold', headPx));
    let note = null;
    if (noteText) {
      const text = ellipsize(noteText, 'normal', notePx, area.w);
      const nw = width(text, 'normal', notePx), ny = y0 + headH + headGap + best.perCol * best.rowH + noteGap;
      const nx = U.clamp(x0 + headW / 2 - nw / 2, area.x, area.x + area.w - nw);
      note = { text: text, x: nx, y: ny, w: nw, h: noteH, fontPx: notePx, baseline: baseline(ny, noteH, 'normal', notePx), color: FN.color || L.row.color };
    }
    const res = {
      heading: { text: L.heading.text, x: x0, y: y0, w: headW, h: headH, fontPx: headPx, baseline: baseline(y0, headH, 'bold', headPx), cx: x0 + headW / 2, color: L.heading.color },
      rows: out, cols: best.cols, fontPx: best.fontPx, rowH: best.rowH, color: L.row.color, blockW: blockW, blockH: blockH, note: note,
    };
    if (o && o.fit) res.fit = fit;
    return res;
  }

  /**
   * An analysis slide's legend (SPEC §6.3): the chain legend, then "Distancias a <referencia>" with
   * the nearest stores — chain icon, short name, distance (es-PE), right-aligned. When the panel is
   * short of space (THE RULE, docs/ARCHITECTURE.md §8.4):
   *   1. both blocks, the chain legend at its theme sizes (16 → 11 pt, 1–3 columns) and the list
   *      from theme analysis.list.sizePt down to minSizePt (12 → 9 pt) with all its rows — the list
   *      shrinks first while that lets the legend grow, and is never in larger type than the legend;
   *   2. else the list loses rows from the bottom, down to list.minRows (or all it has);
   *   3. else only the distance list is shown — its chain icons stand in for the chain legend — with
   *      all its rows, as large as fits (down to half size), then losing rows.
   * The whole block is centred vertically in the legend area. → the usual legend geometry (heading,
   * rows, …; in list-only mode heading.text '' and no rows) + `dist` {heading:{lines:[{text, x, y,
   * w, h, baseline}], fontPx, color}, rows:[{storeId, chainId, text, dist, x, y, h, icon, textX,
   * distX (right edge), distW, baseline, fontPx}], fontPx, color, distColor, y, h} + `listOnly`.
   */
  function analysisLegend(rows, W, style, d) {
    const th = T(), L = th.legend, A = th.analysis.list || {}, k = W / th.slide.width;
    const st = MT.layout.styleOf(style);
    const area = rectIn(L.area, k);
    const N = d.items.length;
    const gap = (A.gapIn === undefined ? 0.24 : A.gapIn) * k;
    const minF = (A.minSizePt || 9) / (A.sizePt || 12);
    const minRows = Math.min(N, A.minRows || 5);
    let chain = null, dist = null, listOnly = false;
    for (let n = N; n >= minRows && !dist; n--) {
      // The list's text is never larger than the chain legend's: shrink it first, as long as that
      // lets the legend grow; else take the largest list that fits beside the legend.
      let any = null;
      for (let f = 1; f >= minF - 1e-9; f -= 0.05) {
        const dl = distBlock(d, n, W, st, area, f);
        if (!rows.length) { if (dl.h <= area.h + 0.5) { dist = dl; break; } continue; }
        const avail = area.h - dl.h - gap;
        if (avail <= 0) continue;
        const cb = legendBlock(rows, W, style, { area: { x: area.x, y: area.y, w: area.w, h: avail }, fit: true });
        if (cb.fit !== 1) continue;
        if (!any) any = { cb: cb, dl: dl };
        if (cb.fontPx >= dl.fontPx - 0.01) { chain = cb; dist = dl; break; }
      }
      if (!dist && any) { chain = any.cb; dist = any.dl; }
    }
    if (!dist) {
      // 3) Only the list (its chain icons identify the chains).
      listOnly = true;
      for (let n = N; n >= 1 && !dist; n--) {
        for (let f = Math.max(1, (A.headingSizePt || 13) / (A.sizePt || 12)); f >= 0.5 - 1e-9 && !dist; f -= 0.05) {
          const dl = distBlock(d, n, W, st, area, f);
          if (dl.h <= area.h + 0.5) dist = dl;
        }
      }
      if (!dist) dist = distBlock(d, 1, W, st, area, 0.5);
    }
    const chainH = chain ? chain.blockH : 0;
    const total = chainH + (chain ? gap : 0) + dist.h;
    const y0 = area.y + Math.max(0, (area.h - total) / 2);
    let lg;
    if (chain) lg = legendBlock(rows, W, style, { area: { x: area.x, y: y0, w: area.w, h: chainH }, top: true });
    else {
      const headPx = th.pt2px(L.heading.sizePt, W);
      lg = { heading: { text: '', x: area.x, y: y0, w: 0, h: 0, fontPx: headPx, baseline: y0, cx: area.x, color: L.heading.color },
        rows: [], cols: 1, fontPx: 0, rowH: 0, color: L.row.color, blockW: 0, blockH: 0, note: null };
    }
    lg.dist = placeDist(dist, chain ? y0 + chainH + gap : y0);
    lg.listOnly = listOnly;
    return lg;
  }
  /** The distance list measured for n rows at scale f (positions relative to its top: placeDist). */
  function distBlock(d, n, W, st, area, f) {
    const th = T(), A = th.analysis.list || {}, k = W / th.slide.width;
    const fontPx = th.pt2px((A.sizePt || 12) * f, W), rowH = (A.rowIn || 0.3) * k * f;
    const headMax = th.pt2px((A.headingSizePt || 13) * Math.max(f, 0.75), W);
    // Heading: one line, else two (split at a word), shrinking a little before an ellipsis.
    let headPx = headMax, lines = null;
    const words = d.heading.split(/\s+/).filter(Boolean);
    for (let s = 0; s <= 4 && !lines; s++) {
      headPx = headMax * (1 - 0.05 * s);
      if (width(d.heading, 'bold', headPx) <= area.w) { lines = [d.heading]; break; }
      // Two lines, the first as long as possible.
      for (let cut = words.length - 1; cut >= 1; cut--) {
        const a = words.slice(0, cut).join(' '), b = words.slice(cut).join(' ');
        if (width(a, 'bold', headPx) <= area.w && width(b, 'bold', headPx) <= area.w) { lines = [a, b]; break; }
      }
    }
    if (!lines) {
      headPx = headMax * 0.8;
      const half = Math.max(1, Math.ceil(words.length / 2));
      lines = [ellipsize(words.slice(0, half).join(' '), 'bold', headPx, area.w), ellipsize(words.slice(half).join(' '), 'bold', headPx, area.w)].filter(Boolean);
    }
    const lineH = headPx * 1.22, headH = lines.length * lineH, headGap = rowH * 0.25;
    // Icons as in the chain legend (card icons are wider: the icon column is as wide as the widest).
    const iconH = (A.iconIn || 0.24) * k * Math.max(f, 0.85);
    const aspect = {};
    let maxAspect = 1;
    d.items.slice(0, n).forEach((r) => {
      let a = 1;
      if (st.kind === 'card') { const dm = MT.markers.dims(r.chainId, { kind: 'card', size: 1 }); a = (dm.w + 2) / (dm.h + 2); }
      aspect[r.chainId] = a; maxAspect = Math.max(maxAspect, Math.min(2.3, a));
    });
    const iconW = iconH * maxAspect, igap = (L_ICON_GAP_IN * k) * f;
    const distW = d.items.slice(0, n).reduce((mx, r) => Math.max(mx, width(r.text, 'bold', fontPx)), 0);
    return { d: d, n: n, f: f, fontPx: fontPx, rowH: rowH, headPx: headPx, lines: lines, lineH: lineH, headH: headH, headGap: headGap,
      iconH: iconH, iconW: iconW, igap: igap, aspect: aspect, distW: distW, x: area.x, w: area.w, h: headH + headGap + n * rowH };
  }
  const L_ICON_GAP_IN = 0.12;
  function placeDist(b, top) {
    const th = T(), A = th.analysis.list || {};
    const head = b.lines.map((text, i) => {
      const y = top + i * b.lineH, w = width(text, 'bold', b.headPx);
      return { text: text, x: b.x, y: y, w: w, h: b.lineH, baseline: baseline(y, b.lineH, 'bold', b.headPx) };
    });
    const nameGap = b.fontPx * 0.6;
    const rows = b.d.items.slice(0, b.n).map((r, i) => {
      const y = top + b.headH + b.headGap + i * b.rowH;
      const iw = Math.min(b.iconW, b.iconH * (b.aspect[r.chainId] || 1)), ih = iw / (b.aspect[r.chainId] || 1);
      const textX = b.x + b.iconW + b.igap;
      const distX = b.x + b.w;
      const maxName = Math.max(10, distX - b.distW - nameGap - textX);
      return {
        storeId: r.storeId, chainId: r.chainId, text: ellipsize(r.short || r.name, 'normal', b.fontPx, maxName), full: r.name, dist: r.text, meters: r.meters,
        x: b.x, y: y, h: b.rowH, icon: { x: b.x + (b.iconW - iw) / 2, y: y + (b.rowH - ih) / 2, w: iw, h: ih },
        textX: textX, textW: maxName, distX: distX, distW: width(r.text, 'bold', b.fontPx), baseline: baseline(y, b.rowH, 'normal', b.fontPx), fontPx: b.fontPx,
      };
    });
    return { heading: { lines: head, fontPx: b.headPx, color: A.color || '#FFFFFF' }, rows: rows, fontPx: b.fontPx, color: A.color || '#FFFFFF',
      distColor: A.distColor || A.color || '#FFFFFF', y: top, h: b.h, x: b.x, w: b.w };
  }

  /** Complete slide geometry in px for a slide W px wide. legendRows default: MT.legend.items(mapCfg). */
  function layout(mapCfg, W, legendRows) {
    const th = T(), k = W / th.slide.width;
    const H = W / th.slide.aspect;
    const frame = rectIn(th.mapFrame, k);
    const titleBox = rectIn(th.title, k), subBox = rectIn(th.subtitle, k);
    const rows = legendRows || (mapCfg ? MT.legend.items(mapCfg) : []);
    const deco = th.slide.decoration;
    return {
      W: W, H: H, k: k,
      leftArea: rectIn(th.slide.leftArea, k),
      // Optional template decoration over the left area (theme slide.decoration), or null.
      decoration: deco && deco.src ? Object.assign({ src: deco.src }, rectIn({ x: deco.x === undefined ? th.slide.leftArea.x : deco.x, y: deco.y === undefined ? th.slide.leftArea.y : deco.y,
        w: deco.w === undefined ? th.slide.leftArea.w : deco.w, h: deco.h === undefined ? th.slide.leftArea.h : deco.h }, k)) : null,
      title: titleLayout(mapCfg ? mapCfg.title : '', titleBox, W),
      subtitle: subtitleLayout(mapCfg, subBox, frame.y, W),
      frame: frame,
      panel: rectIn(th.panel, k),
      legend: legendLayout(rows, W, mapCfg),
    };
  }

  /* ---- DOM preview ---------------------------------------------------------------------------------- */
  let host = null, slideEl = null, els = {}, cur = null, curId = null, ro = null, pending = false, lastW = 0;

  function mount(el) {
    if (host && host.parentNode === el) return slideEl;
    if (host) { el.appendChild(host); fit(); return slideEl; }
    host = h('div', { class: 'mt-slide-host' });
    slideEl = h('div', { class: 'mt-slide', role: 'group', 'aria-label': MT.t('map.slide.aria') });
    els.left = h('div', { class: 'mt-slide__left' });
    els.deco = h('img', { class: 'mt-slide__deco', alt: '', 'aria-hidden': 'true', hidden: true, style: { position: 'absolute', pointerEvents: 'none' } });
    els.title = h('div', { class: 'mt-slide__title' });
    els.subtitle = h('div', { class: 'mt-slide__subtitle' });
    els.frame = h('div', { class: 'mt-slide__frame' });
    els.panel = h('div', { class: 'mt-slide__panel', 'aria-hidden': 'false' });
    els.circles = h('div', { class: 'mt-slide__circles', 'aria-hidden': 'true' });
    els.legend = h('div', { class: 'mt-slide__legend', role: 'list', 'aria-label': MT.t('map.legend.aria') });
    els.panel.appendChild(els.circles);
    els.panel.appendChild(els.legend);
    U.append(slideEl, [els.left, els.deco, els.title, els.subtitle, els.frame, els.panel]);
    host.appendChild(slideEl);
    el.appendChild(host);
    MT.mapview.mount(els.frame);
    ro = new ResizeObserver(() => fit());
    ro.observe(host);
    // Re-render when the shown map or its data change (coalesced; M2 also calls render directly).
    const later = () => {
      if (pending || !curId) return;
      pending = true;
      requestAnimationFrame(() => { if (!pending) return; pending = false; const m = MT.project.getMap(curId); if (m) render(m); });
    };
    MT.bus.on('map:changed', (e) => { if (e && e.id === curId) later(); });
    MT.bus.on('stores:changed', later);
    MT.bus.on('chains:changed', later);
    MT.bus.on('logos:changed', later);
    MT.bus.on('lang:changed', () => {
      slideEl.setAttribute('aria-label', MT.t('map.slide.aria'));
      els.legend.setAttribute('aria-label', MT.t('map.legend.aria'));
      paint();
    });
    fit();
    return slideEl;
  }

  /** Size the slide to the host (16:9, centred) and repaint. */
  function fit() {
    if (!host) return;
    const cw = host.clientWidth, ch = host.clientHeight;
    if (!cw || !ch) return;
    const pad = Math.max(12, Math.min(28, cw * 0.025));
    const aspect = T().slide.aspect;
    const W = Math.max(320, Math.floor(Math.min(cw - 2 * pad, (ch - 2 * pad) * aspect)));
    const H = W / aspect;
    slideEl.style.width = W + 'px';
    slideEl.style.height = H + 'px';
    slideEl.style.left = Math.max(0, (cw - W) / 2) + 'px';
    slideEl.style.top = Math.max(0, (ch - H) / 2) + 'px';
    if (W !== lastW) { lastW = W; paint(); }
  }

  function px(v) { return v + 'px'; }
  function place(el, r) { el.style.left = px(r.x); el.style.top = px(r.y); el.style.width = px(r.w); el.style.height = px(r.h); }

  function paint() {
    if (!slideEl || !lastW) return;
    const th = T(), W = lastW;
    const legendRows = cur ? MT.legend.items(cur) : [];
    const g = layout(cur, W, legendRows);
    slideEl.style.background = th.slide.background;
    slideEl.style.fontFamily = th.fonts.slideCss;
    place(els.left, g.leftArea); els.left.style.background = th.slide.leftArea.color;
    els.deco.hidden = !g.decoration;
    if (g.decoration) { place(els.deco, g.decoration); if (els.deco.getAttribute('src') !== g.decoration.src) els.deco.src = g.decoration.src; }

    // Title (placeholder in the preview only — never exported).
    const t = g.title;
    place(els.title, t);
    els.title.style.fontSize = px(t.fontPx);
    els.title.style.lineHeight = px(t.h);
    els.title.style.color = t.color;
    els.title.style.textAlign = th.title.align;
    const empty = !t.text;
    els.title.classList.toggle('is-placeholder', empty);
    els.title.textContent = empty ? (cur ? MT.t('map.slide.titlePlaceholder') : '') : t.text;
    els.title.title = t.full !== t.text ? t.full : '';

    // Subtitle lines.
    const s = g.subtitle;
    U.clear(els.subtitle);
    place(els.subtitle, { x: s.x, y: s.lines.length ? s.lines[0].y : s.y, w: s.w, h: s.lines.length * s.lineH });
    els.subtitle.style.fontSize = px(s.fontPx);
    s.lines.forEach((ln) => {
      const line = h('div', { class: 'mt-slide__subline', style: { height: px(ln.h), lineHeight: px(ln.h) } });
      ln.runs.forEach((r) => {
        const span = h('span', { class: 'mt-slide__run mt-slide__run--' + r.kind, style: { color: r.color } }, r.text);
        if (r.kind === 'peso') {
          span.style.fontWeight = th.subtitle.peso.bold ? '700' : '400';
          if (th.subtitle.peso.underline) {
            span.style.textDecorationLine = 'underline';
            span.style.textDecorationThickness = px(s.underline.thickness);
            span.style.textUnderlineOffset = px(s.underline.offset);
          }
        }
        line.appendChild(span);
      });
      els.subtitle.appendChild(line);
    });

    // Map frame.
    place(els.frame, g.frame);
    els.frame.style.background = th.mapFrame.background;
    els.frame.style.boxShadow = th.mapFrame.border && th.mapFrame.border.widthPt ? 'inset 0 0 0 ' + px(th.pt2px(th.mapFrame.border.widthPt, W)) + ' ' + th.mapFrame.border.color : '';

    // Panel: gradient + faint circles.
    place(els.panel, g.panel);
    els.panel.style.background = th.panelCss();
    const k = g.k;
    if (els.circles.dataset.w !== String(W)) {
      els.circles.dataset.w = String(W);
      U.clear(els.circles);
      th.panel.circles.forEach((c) => {
        els.circles.appendChild(h('div', { class: 'mt-slide__circle', style: {
          left: px((c.cx - c.r) * k), top: px((c.cy - c.r) * k), width: px(2 * c.r * k), height: px(2 * c.r * k),
          background: 'rgba(255,255,255,' + c.alpha + ')' } }));
      });
    }
    paintLegend(g.legend, g.panel);
  }

  function paintLegend(lg, panel) {
    U.clear(els.legend);
    const dpr = window.devicePixelRatio || 1;
    const style = MT.layout.styleOf(cur);
    if (lg.heading.text) {
      els.legend.appendChild(h('div', { class: 'mt-slide__legend-heading', role: 'presentation', style: {
        left: px(lg.heading.x - panel.x), top: px(lg.heading.y - panel.y), width: px(lg.heading.w), height: px(lg.heading.h),
        lineHeight: px(lg.heading.h), fontSize: px(lg.heading.fontPx), color: lg.heading.color } }, lg.heading.text));
    }
    const chainIds = lg.rows.map((r) => r.chainId);
    const icons = [];
    lg.rows.forEach((r) => {
      const holder = h('span', { class: 'mt-slide__legend-icon', style: { left: px(r.icon.x - r.x), top: px(r.icon.y - r.y), width: px(r.icon.w), height: px(r.icon.h) } });
      icons.push({ holder: holder, row: r });
      els.legend.appendChild(h('div', { class: 'mt-slide__legend-row', role: 'listitem', dataset: { chainId: r.chainId }, style: {
        left: px(r.x - panel.x), top: px(r.y - panel.y), height: px(r.h), color: lg.color } },
        holder,
        h('span', { class: 'mt-slide__legend-text', style: { left: px(r.textX - r.x), fontSize: px(r.fontPx), lineHeight: px(r.h) } }, r.text)));
    });
    // Key for the grouped logos ("×N = N tiendas cercanas · • = ubicación exacta").
    if (lg.note) {
      els.legend.appendChild(h('div', { class: 'mt-slide__legend-note', role: 'note', style: {
        position: 'absolute', left: px(lg.note.x - panel.x), top: px(lg.note.y - panel.y), width: px(lg.note.w + 2), height: px(lg.note.h),
        lineHeight: px(lg.note.h), fontSize: px(lg.note.fontPx), color: lg.note.color, whiteSpace: 'nowrap', fontWeight: '400' } }, lg.note.text));
    }
    // Analysis slide: "Distancias a <referencia>" — the nearest stores with their distance.
    if (lg.dist) {
      const D = lg.dist;
      D.heading.lines.forEach((ln) => {
        els.legend.appendChild(h('div', { class: 'mt-slide__dist-heading', role: 'presentation', style: {
          left: px(ln.x - panel.x), top: px(ln.y - panel.y), width: px(Math.max(ln.w + 2, D.w)), height: px(ln.h),
          lineHeight: px(ln.h), fontSize: px(D.heading.fontPx), color: D.heading.color } }, ln.text));
      });
      D.rows.forEach((r) => {
        const holder = h('span', { class: 'mt-slide__legend-icon', style: { left: px(r.icon.x - r.x), top: px(r.icon.y - r.y), width: px(r.icon.w), height: px(r.icon.h) } });
        icons.push({ holder: holder, row: r });
        chainIds.push(r.chainId);
        els.legend.appendChild(h('div', { class: 'mt-slide__dist-row', role: 'listitem', title: r.full + ' — ' + r.dist, dataset: { storeId: r.storeId, chainId: r.chainId }, style: {
          left: px(r.x - panel.x), top: px(r.y - panel.y), width: px(r.distX - r.x), height: px(r.h), color: D.color } },
          holder,
          h('span', { class: 'mt-slide__dist-name', style: { left: px(r.textX - r.x), width: px(r.textW), fontSize: px(r.fontPx), lineHeight: px(r.h) } }, r.text),
          h('span', { class: 'mt-slide__dist-value', style: { right: '0px', fontSize: px(r.fontPx), lineHeight: px(r.h), color: D.distColor } }, r.dist)));
      });
    }
    const drawIcons = () => icons.forEach((o) => {
      const cv = MT.markers.icon(o.row.chainId, Math.round(o.row.icon.h * dpr), style);
      cv.style.width = px(o.row.icon.w); cv.style.height = px(o.row.icon.h);
      U.clear(o.holder); o.holder.appendChild(cv);
    });
    if (MT.markers.isReady(chainIds, style)) drawIcons();
    else {
      const token = els.legend.dataset.token = String(Date.now() + Math.random());
      MT.markers.ready(chainIds, style).then(() => { if (els.legend.dataset.token === token) drawIcons(); });
    }
  }

  function render(mapCfg) {
    pending = false;
    cur = mapCfg || null;
    curId = cur ? cur.id : null;
    if (!slideEl) return;
    slideEl.classList.toggle('is-empty', !cur);
    paint();
    MT.mapview.render(cur);
    MT.bus.emit('slide:rendered', { id: curId });
  }

  MT.slide = {
    mount: mount,
    render: render,
    element: function () { return slideEl; },
    current: function () { return cur; },
    layout: layout,
    legendLayout: legendLayout,
    font: font,
    metrics: metrics,
    textWidth: width,
    /** Re-measure the container (also automatic through a ResizeObserver). */
    resize: fit,
  };
})();
