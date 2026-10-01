// topo.mjs — tiny TopoJSON helpers for the seed tools (Node built-ins only).
//   readDistrictsJs(file)        → the Topology assigned to window.MT_DISTRICTS in data/districts.js
//   topoFeatures(topo, keep?)    → GeoJSON-like features [{properties, bbox, geometry}] (keep(props) filters)

import { readFileSync } from 'node:fs';
import vm from 'node:vm';

export function readDistrictsJs(file) {
  const ctx = { window: {} };
  vm.runInNewContext(readFileSync(file, 'utf8'), ctx, { filename: file });
  return ctx.window.MT_DISTRICTS;
}

function decodeArcs(topo) {
  const t = topo.transform;
  return topo.arcs.map((arc) => {
    let x = 0, y = 0;
    return arc.map((p) => {
      if (t) { x += p[0]; y += p[1]; return [x * t.scale[0] + t.translate[0], y * t.scale[1] + t.translate[1]]; }
      return p.slice(0, 2);
    });
  });
}

export function topoFeatures(topo, keep = () => true, objectName = 'districts') {
  const arcs = decodeArcs(topo);
  const ring = (ids) => {
    const out = [];
    ids.forEach((id, k) => {
      const a = id < 0 ? arcs[~id].slice().reverse() : arcs[id];
      a.forEach((pt, i) => { if (i > 0 || k === 0) out.push(pt); });
    });
    return out;
  };
  const feats = [];
  for (const g of topo.objects[objectName].geometries) {
    if (!keep(g.properties)) continue;
    let geometry = null;
    if (g.type === 'Polygon') geometry = { type: 'Polygon', coordinates: g.arcs.map(ring) };
    else if (g.type === 'MultiPolygon') geometry = { type: 'MultiPolygon', coordinates: g.arcs.map((p) => p.map(ring)) };
    feats.push({ type: 'Feature', properties: g.properties, bbox: g.bbox, geometry });
  }
  return feats;
}
