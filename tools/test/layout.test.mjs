// tools/test/layout.test.mjs — MT.layout declutter (SPEC §4.2) on synthetic dense clusters.
//
//   node tools/test/layout.test.mjs
//
// Asserts: no overlapping markers, every marker inside the frame, no marker hiding a store dot,
// deterministic (same input → identical output, also with shuffled input order), manual drags are
// fixed obstacles, and a dense Miraflores case with 160+ markers (Tambo/Oxxo on) lays out in < 150 ms.
// Same-chain grouping (mapCfg.groupNearby): automatic on a crowded map, off / on per map, one item
// per store (legend counts unchanged), compact groups of one chain, a dragged group stays together.
// Leaders and labels: a store whose dot sits inside a name leaves it by the shortest path.
// Runs in the real app page (file://, no network needed): MT.layout.place / MT.layout.compute.

import { openApp, makeChecker } from './lib.mjs';

const { check, finish } = makeChecker('layout');
const { browser, page, errors } = await openApp({ lang: 'es', viewport: { width: 1200, height: 800 } });

const results = await page.evaluate(() => {
  const F = MT.layout.frame();
  // Deterministic pseudo-random generator (tests only).
  function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
  function gauss(r) { const u = Math.max(1e-9, r()), v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
  const dc = MT.theme.marker.declutter;
  const baseOpts = (shape) => ({ width: F.width, height: F.height, shape, stem: MT.theme.marker.stem, rings: dc.rings, angles: dc.angles,
    minGap: dc.minGap, passes: dc.passes, margin: 3, anchorRadius: 4.5, obstacles: [] });

  function check(nodes, out, shape, gap, dots) {
    dots = dots || nodes;
    let overlaps = 0, outside = 0, coveredDots = 0, worst = 0;
    for (let i = 0; i < nodes.length; i++) {
      const a = out[i], na = nodes[i];
      if (a.x - na.w / 2 < -0.01 || a.x + na.w / 2 > F.width + 0.01 || a.y - na.h / 2 < -0.01 || a.y + na.h / 2 > F.height + 0.01) outside++;
      for (let j = i + 1; j < nodes.length; j++) {
        const b = out[j], nb = nodes[j];
        let pen;
        if (shape === 'circle') pen = na.w / 2 + nb.w / 2 - Math.hypot(a.x - b.x, a.y - b.y);
        else { const ox = (na.w + nb.w) / 2 - Math.abs(a.x - b.x), oy = (na.h + nb.h) / 2 - Math.abs(a.y - b.y); pen = ox > 0 && oy > 0 ? Math.min(ox, oy) : -1; }
        if (pen > 0.01) { overlaps++; worst = Math.max(worst, pen); }
      }
      // A marker must not sit on top of any store dot (its own included) — unless the user put it there.
      for (let j = 0; j < dots.length && !na.fixed; j++) {
        const nd = dots[j];
        const inside = shape === 'circle' ? Math.hypot(nd.ax - a.x, nd.ay - a.y) < na.w / 2 - 0.5
          : Math.abs(nd.ax - a.x) < na.w / 2 - 0.5 && Math.abs(nd.ay - a.y) < na.h / 2 - 0.5;
        if (inside) coveredDots++;
      }
    }
    return { overlaps, outside, coveredDots, worst: +worst.toFixed(2) };
  }
  function cluster(seed, n, cx, cy, sigma, w, h) {
    const r = rng(seed), nodes = [];
    for (let i = 0; i < n; i++) {
      const x = Math.min(F.width - 1, Math.max(1, cx + gauss(r) * sigma)), y = Math.min(F.height - 1, Math.max(1, cy + gauss(r) * sigma));
      nodes.push({ ax: x, ay: y, w, h, fixed: null, key: 's' + String(i).padStart(4, '0') });
    }
    return nodes;
  }
  function run(name, nodes, shape) {
    const t0 = performance.now();
    const out = MT.layout.place(nodes, baseOpts(shape));
    const ms = performance.now() - t0;
    const again = MT.layout.place(nodes.map((n) => Object.assign({}, n)), baseOpts(shape));
    // Shuffled input order must give the same position for every key.
    const r = rng(99), shuffled = nodes.map((n, i) => [r(), i]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
    const out3 = MT.layout.place(shuffled.map((i) => Object.assign({}, nodes[i])), baseOpts(shape));
    const byKey = {};
    shuffled.forEach((idx, k) => { byKey[nodes[idx].key] = out3[k]; });
    const same = out.every((p, i) => p.x === again[i].x && p.y === again[i].y);
    const sameShuffled = out.every((p, i) => Math.abs(p.x - byKey[nodes[i].key].x) < 1e-9 && Math.abs(p.y - byKey[nodes[i].key].y) < 1e-9);
    const displaced = out.filter((p) => p.displaced).length;
    return Object.assign({ name, n: nodes.length, ms: Math.round(ms * 10) / 10, same, sameShuffled, displaced }, check(nodes, out, shape));
  }

  const D = MT.theme.marker.badge.diameter;
  const res = [];
  // 1. Tight cluster: 40 badges with sigma 45 units (most anchors closer than one badge).
  res.push(run('tight cluster 40 badges', cluster(1, 40, 500, 420, 45, D, D), 'circle'));
  // 2. Two clusters near the frame edges (top-left corner and right edge).
  res.push(run('edge clusters 50 badges', cluster(2, 25, 30, 25, 40, D, D).concat(cluster(3, 25, 985, 600, 35, D, D).map((n, i) => Object.assign(n, { key: 'e' + i }))), 'circle'));
  // 3. City-wide spread with a dense corridor: 150 badges.
  {
    const r = rng(7), nodes = [];
    for (let i = 0; i < 150; i++) {
      const corridor = i % 3 === 0;
      const x = corridor ? 380 + gauss(r) * 40 : 80 + r() * 840, y = corridor ? 120 + r() * 600 : 60 + r() * 720;
      nodes.push({ ax: x, ay: y, w: D, h: D, fixed: null, key: 'c' + String(i).padStart(4, '0') });
    }
    res.push(run('city 150 badges + corridor', nodes, 'circle'));
  }
  // 4. Cards (rectangles of mixed widths): 45 cards in a cluster.
  {
    const nodes = cluster(11, 45, 520, 430, 70, 0, 0).map((n, i) => Object.assign(n, { w: [104, 84, 66, 30, 95][i % 5], h: 30 }));
    res.push(run('cards cluster 45', nodes, 'rect'));
  }
  // 5. Manual drag = fixed obstacle in the middle of a cluster.
  {
    const nodes = cluster(5, 30, 500, 420, 40, D, D);
    nodes[0].fixed = { x: 500, y: 420 };
    const out = MT.layout.place(nodes, baseOpts('circle'));
    const fixedOk = out[0].x === 500 && out[0].y === 420;
    res.push(Object.assign({ name: 'manual fixed obstacle', n: 30, fixedOk }, check(nodes, out, 'circle')));
  }

  // 6. Dense Miraflores with Tambo/Oxxo through the real compute() (projection, fit, dims).
  {
    const r = rng(2026);
    const chains = ['tambo', 'oxxo', 'tambo', 'oxxo', 'plazavea', 'wong', 'metro', 'tottus', 'vivanda', 'mass', 'tiendas3a', 'dollarcity', 'florayfauna', 'holi'];
    const stores = [];
    const hubs = [[-12.1219, -77.0297], [-12.1253, -77.0228], [-12.1185, -77.0353], [-12.1302, -77.0262], [-12.1120, -77.0300]];
    for (let i = 0; i < 165; i++) {
      const hub = hubs[i % hubs.length], hubby = r() < 0.55;
      const lat = hubby ? hub[0] + gauss(r) * 0.0028 : -12.135 + r() * 0.03;
      const lng = hubby ? hub[1] + gauss(r) * 0.0028 : -77.045 + r() * 0.035;
      stores.push({ id: 'syn-' + String(i).padStart(4, '0'), chain: chains[i % chains.length], name: 'Tienda ' + i, lat, lng, status: 'verified', ubigeo: '150122' });
    }
    const cfg = MT.project.defaultMap({ id: 'syn-miraflores', districts: ['150122'], chains: { tambo: true, oxxo: true } });
    const view = MT.layout.fitView(MT.geo.bboxOfPoints(stores), MT.layout.fitPadding(cfg));
    const t0 = performance.now();
    const items = MT.layout.compute(cfg, { stores, view });
    const ms = performance.now() - t0;
    const items2 = MT.layout.compute(cfg, { stores: stores.slice().reverse(), view });
    const pos = (list) => JSON.stringify(list.map((it) => [it.storeId, it.pos.x, it.pos.y, !!it.collapsed]).sort());
    // Logos that found no room within the leader cap (collapsed) and stores drawn by their chain's
    // group logo (grouped) are store dots, not markers.
    const logos = items.filter((it) => !it.collapsed && !it.grouped);
    const nodes = logos.map((it) => ({ ax: it.anchor.x, ay: it.anchor.y, w: it.w, h: it.h }));
    const out = logos.map((it) => ({ x: it.pos.x, y: it.pos.y }));
    const dots = items.map((it) => ({ ax: it.anchor.x, ay: it.anchor.y }));
    const D = MT.theme.markerDims('badge', 1).w, cap = MT.theme.marker.declutter.maxLeader * D + 3;
    const maxLeader = Math.max(0, ...logos.filter((it) => it.leader).map((it) => Math.hypot(it.leader.x2 - it.leader.x1, it.leader.y2 - it.leader.y1)));
    res.push(Object.assign({ name: 'Miraflores 165 stores (compute)', n: items.length, ms: Math.round(ms), same: pos(items) === pos(items2), sameShuffled: true,
      displaced: items.filter((i) => i.displaced).length, leaders: items.filter((i) => i.leader).length,
      collapsed: items.filter((it) => it.collapsed).length, maxLeader: Math.round(maxLeader), cap: Math.round(cap), capOk: maxLeader <= cap,
      collapsedSane: items.filter((it) => it.collapsed).length < items.length * 0.6 && items.stats.collapsed === items.filter((it) => it.collapsed).length }, check(nodes, out, 'circle', 0, dots)));
    // Same-chain grouping on this crowded map: automatic, one item per store, compact one-chain groups.
    {
      const g = items.stats.grouping, reps = items.filter((it) => it.count > 1), byId = {};
      items.forEach((it) => { byId[it.storeId] = it; });
      const unit = MT.theme.markerDims('badge', 1).w, agg = MT.theme.marker.declutter.aggregate, rMax = (agg.radiusMax || agg.radius) * unit + 0.01;
      let compact = true, sameChain = true, membersOk = true, legendOk = true;
      reps.forEach((r) => {
        const ms = r.members.map((id) => byId[id]);
        if (ms.some((m) => !m || m.chainId !== r.chainId)) sameChain = false;
        if (ms.length !== r.count || ms.some((m) => m !== r && (!m.grouped || m.groupOf !== r.storeId || m.leader))) membersOk = false;
        for (let a = 0; a < ms.length; a++) for (let b = a + 1; b < ms.length; b++) if (Math.hypot(ms[a].anchor.x - ms[b].anchor.x, ms[a].anchor.y - ms[b].anchor.y) > rMax) compact = false;
        // The leader starts at one of the group's dots.
        const from = byId[r.leaderFrom];
        const fd = from && (from.dot || from.anchor);
        if (r.leader && (!from || Math.hypot(r.leader.x1 - fd.x, r.leader.y1 - fd.y) > 1e-6)) membersOk = false;
      });
      const counts = (list) => JSON.stringify(MT.legend.items(cfg, list).map((x) => x.text));
      const off = MT.layout.compute(Object.assign({}, cfg, { groupNearby: false }), { stores, view });
      const on = MT.layout.compute(Object.assign({}, cfg, { groupNearby: true }), { stores, view });
      legendOk = counts(items) === counts(off) && items.length === stores.length && off.length === stores.length;
      const again = MT.layout.compute(cfg, { stores: stores.slice().reverse(), view });
      res.push({ name: 'Miraflores 165 stores: same-chain grouping', n: items.length, auto: g.mode === 'auto' && g.on && g.auto, groups: reps.length, grouped: g.grouped,
        markers: logos.length, offGroups: off.filter((it) => it.count > 1).length, onGroups: on.filter((it) => it.count > 1).length,
        compact, sameChain, membersOk, legendOk, same: pos(items) === pos(again), sameShuffled: true, overlaps: 0, outside: 0, coveredDots: 0, grouping: true });
      // A grouped logo dragged by the user (offset with g: 1 on its store) stays together at that spot.
      if (reps.length) {
        const r = reps[0], W = MT.layout.frame().width;
        const offsets = { [r.storeId]: { dx: (r.pos.x - r.anchor.x + 30) / W, dy: (r.pos.y - r.anchor.y - 20) / W, g: 1 } };
        const moved = MT.layout.compute(Object.assign({}, cfg, { markerOffsets: offsets }), { stores, view });
        const mr = moved.find((it) => it.storeId === r.storeId);
        res.push({ name: 'dragged group logo', n: 1, overlaps: 0, outside: 0, coveredDots: 0,
          groupDragOk: !!mr && mr.count === r.count && Math.abs(mr.pos.x - (r.pos.x + 30)) < 1e-6 && Math.abs(mr.pos.y - (r.pos.y - 20)) < 1e-6 && mr.manual });
      }
    }
    // Same at 0.8 size and for the number style.
    const cfg2 = Object.assign({}, cfg, { markerStyle: 'number' });
    const t1 = performance.now();
    const items3 = MT.layout.compute(cfg2, { stores, view });
    const ms3 = performance.now() - t1;
    const nums = items3.map((i) => i.number).sort((a, b) => a - b);
    res.push(Object.assign({ name: 'Miraflores 165 stores (number style)', n: items3.length, ms: Math.round(ms3), same: true, sameShuffled: true,
      numbersOk: nums.every((v, i) => v === i + 1) }, check(items3.map((it) => ({ ax: it.anchor.x, ay: it.anchor.y, w: it.w, h: it.h })), items3.map((it) => ({ x: it.pos.x, y: it.pos.y })), 'circle')));
    // 6b. Visual QA round 2 on the same crowded map: logos drawn smaller when 'auto' groups
    //     (aggregate.autoSize), every grouped store tied to its logo by the leader or the spokes
    //     (a tree: spoke to the logo or link to another store of the group), store dots of shops at
    //     the same spot spread apart, the dots a leader starts at painted last, the legend key.
    {
      const items = MT.layout.compute(cfg, { stores, view });
      const agg = MT.theme.marker.declutter.aggregate, byId = {};
      items.forEach((it) => { byId[it.storeId] = it; });
      const eff = items.stats.size, want = (cfg.markerSize || 1) * agg.autoSize;
      const sizeOk = items.stats.grouping.auto && Math.abs(eff - want) < 1e-9 && items.filter((it) => !it.grouped && !it.collapsed).every((it) => Math.abs(it.w - MT.theme.markerDims('badge', eff).w) < 1e-9);
      let tied = true, nSpokes = 0;
      items.filter((it) => it.count > 1).forEach((r) => {
        const sp = r.spokes || [];
        nSpokes += sp.length;
        // Every member but the leader's store has exactly one spoke starting at its dot; the tree reaches the logo.
        const from = {};
        sp.forEach((s) => { from[s.storeId] = (from[s.storeId] || 0) + 1; const d = byId[s.storeId].dot; if (Math.hypot(s.x1 - d.x, s.y1 - d.y) > 1e-6) tied = false; if (s.to && r.members.indexOf(s.to) < 0) tied = false; });
        r.members.forEach((id) => { if (id !== r.leaderFrom && from[id] !== 1 && !(r.leader === null && !from[id])) tied = false; });
        if (sp.length > r.count - 1) tied = false;
        const reach = new Set([r.leaderFrom]);
        for (let k = 0; k < r.count; k++) sp.forEach((s) => { if (!s.to || reach.has(s.to)) reach.add(s.storeId); });
        if (reach.size < r.count) tied = false;
      });
      // Dots: two stores at the very same spot → their dots apart, each within one radius of its store.
      const r = MT.theme.marker.anchorDot.radius, sp = MT.theme.marker.anchorDot.spread;
      const same = [{ ax: 500, ay: 400, key: 'b' }, { ax: 500, ay: 400, key: 'a' }, { ax: 500.5, ay: 400, key: 'c' }, { ax: 640, ay: 400, key: 'd' }];
      const out = MT.layout.spreadDots(same, r, sp.sep, sp.max), out2 = MT.layout.spreadDots(same.slice().reverse(), r, sp.sep, sp.max).reverse();
      let minD = Infinity, maxMove = 0;
      for (let a = 0; a < 3; a++) { maxMove = Math.max(maxMove, Math.hypot(out[a].x - same[a].ax, out[a].y - same[a].ay)); for (let b = a + 1; b < 3; b++) minD = Math.min(minD, Math.hypot(out[a].x - out[b].x, out[a].y - out[b].y)); }
      const spreadOk = minD > r * 1.2 && maxMove <= r * sp.max + 1e-6 && out[3].x === 640 && JSON.stringify(out) === JSON.stringify(out2);
      // Paint order: a leader's own dot is drawn after the others.
      const order = MT.markers.dotOrder(items), starts = new Set(items.filter((it) => it.leader).map((it) => it.leaderFrom || it.storeId));
      const firstStart = order.findIndex((it) => starts.has(it.storeId)), orderOk = order.slice(firstStart).every((it) => starts.has(it.storeId));
      // Legend key: only when logos stand for several stores.
      const off = MT.layout.compute(Object.assign({}, cfg, { groupNearby: false }), { stores, view });
      const keyOk = !!MT.legend.items(cfg, items).footnote && MT.legend.items(cfg, off).footnote === null;
      res.push({ name: 'visual QA 2: crowded map', n: items.length, overlaps: 0, outside: 0, coveredDots: 0, qa2: true, sizeOk, eff, tied, nSpokes, spreadOk, minD: +minD.toFixed(2), maxMove: +maxMove.toFixed(2), orderOk, keyOk });
    }
  }
  // 7. A store whose dot sits inside a district name (an obstacle box): its leader leaves the name by
  //    the shortest way (below, through 4 units of text) — not up through the whole name.
  {
    const box = { x: 380, y: 400, w: 240, h: 26 };
    const nodes = [{ ax: 500, ay: 422, w: D, h: D, fixed: null, key: 'a' }];
    const opts = Object.assign(baseOpts('circle'), { obstacles: [box] });
    const out = MT.layout.place(nodes, opts)[0];
    const segIn = (l) => { let n = 0; for (let t = 0; t <= 1.0001; t += 0.01) { const x = l.x1 + (l.x2 - l.x1) * t, y = l.y1 + (l.y2 - l.y1) * t; if (x > box.x && x < box.x + box.w && y > box.y && y < box.y + box.h) n++; } return n / 100 * Math.hypot(l.x2 - l.x1, l.y2 - l.y1); };
    const inside = out.leader ? segIn(out.leader) : 0;
    const markerClear = !(out.x + D / 2 > box.x && out.x - D / 2 < box.x + box.w && out.y + D / 2 > box.y && out.y - D / 2 < box.y + box.h);
    res.push({ name: 'leader out of a district name', n: 1, overlaps: 0, outside: 0, coveredDots: 0, labelExit: markerClear && inside <= 6, inside: Math.round(inside * 10) / 10, pos: [Math.round(out.x), Math.round(out.y)] });
  }
  return res;
});

for (const r of results) {
  console.log(`  ${r.name}: ${JSON.stringify(r)}`);
  check(r.overlaps === 0, `${r.name}: no overlapping markers (${r.overlaps}, worst ${r.worst})`);
  check(r.outside === 0, `${r.name}: all markers inside the frame`);
  // With the leader cap (compute), a logo may sit over a NEIGHBOUR's dot when nothing closer is
  // free; store dots are painted above the logos, so every location still shows. Keep it rare.
  if (r.capOk !== undefined) check(r.coveredDots <= Math.ceil(r.n * 0.2), `${r.name}: few logos over a neighbour's dot (${r.coveredDots}; dots are drawn on top)`);
  else check(r.coveredDots === 0, `${r.name}: no marker covers a store dot (${r.coveredDots})`);
  if (r.same !== undefined) check(r.same && r.sameShuffled, `${r.name}: deterministic (repeat ${r.same}, shuffled ${r.sameShuffled})`);
  if (r.fixedOk !== undefined) check(r.fixedOk, `${r.name}: manual marker stays where it was dragged`);
  if (r.numbersOk !== undefined) check(r.numbersOk, `${r.name}: numbers 1..n`);
  if (r.capOk !== undefined) check(r.capOk, `${r.name}: every leader within the cap (${r.maxLeader} ≤ ${r.cap} units)`);
  if (r.collapsedSane !== undefined) check(r.collapsedSane, `${r.name}: ${r.collapsed} of ${r.n} logos shown as dots (no room near the store), counted in stats`);
  if (/Miraflores/.test(r.name) && r.ms !== undefined) check(r.n >= 150 && r.ms < 150, `${r.name}: ${r.n} markers laid out in ${r.ms} ms (< 150 ms)`);
  if (r.grouping) {
    check(r.auto && r.groups > 0 && r.markers < r.n * 0.8, `${r.name}: grouped automatically on a crowded map (${r.groups} logos with a count stand for ${r.grouped} stores; ${r.markers} logos for ${r.n} stores)`);
    check(r.offGroups === 0 && r.onGroups > 0, `${r.name}: groupNearby false → no groups (${r.offGroups}), true → groups (${r.onGroups})`);
    check(r.sameChain && r.compact, `${r.name}: every group is one chain, all its stores within the grouping radius`);
    check(r.membersOk, `${r.name}: one item per store — grouped stores are dots of their group, the leader starts at a group dot`);
    check(r.legendOk, `${r.name}: legend counts unchanged by grouping`);
  }
  if (r.groupDragOk !== undefined) check(r.groupDragOk, `${r.name}: a group dragged by the user stays one logo where it was dropped`);
  if (r.labelExit !== undefined) check(r.labelExit, `${r.name}: the logo keeps off the name and the leader crosses ${r.inside} units of it (at ${r.pos})`);
  if (r.qa2) {
    check(r.sizeOk, `${r.name}: logos drawn at ${Math.round(r.eff * 100)} % when grouping turns on by itself (aggregate.autoSize)`);
    check(r.tied && r.nSpokes > 0, `${r.name}: every grouped store tied to its logo by the leader or a spoke (${r.nSpokes} spokes)`);
    check(r.spreadOk, `${r.name}: dots of stores at one spot spread apart (min ${r.minD} units, each ≤ ${r.maxMove} from its store), deterministic`);
    check(r.orderOk, `${r.name}: the dots leaders start at are painted last`);
    check(r.keyOk, `${r.name}: legend key ("×N …") only when logos stand for several stores`);
  }
}
// The district-name cache settles: a re-harvest a few metres off (vector-tile quantization at another
// zoom) is ignored; another point only replaces it when better (inside the district, then smaller key).
const pl = await page.evaluate(() => {
  const P = MT.layout.places, u = '130103';                       // Florencia de Mora (Trujillo)
  const before = JSON.stringify(P.get(u));
  P.set({ [u]: { ll: [-79.02365, -8.08207], c: 'suburb', inside: true } });
  const a = JSON.stringify(P.get(u));
  P.set({ [u]: { ll: [-79.02367, -8.08205], c: 'suburb', inside: true } });     // 3 m off
  const b = JSON.stringify(P.get(u));
  P.set({ [u]: { ll: [-79.09, -8.20], c: 'suburb', inside: false } });          // far, outside the district
  const c = JSON.stringify(P.get(u));
  return { before, a, b, c };
});
check(pl.a === pl.b && pl.b === pl.c && /-79\.02365/.test(pl.a), `place cache settles: a point 3 m off or a worse one never replaces the cached one (${pl.a})`);
check(errors.length === 0, `no console errors (${errors.length})`);
errors.forEach((e) => console.log('    ', e));
await browser.close();
finish();
