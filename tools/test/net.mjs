// tools/test/net.mjs — live network check of MT.geo from the app opened via file:// (Origin: null).
// Not part of the smoke test (it depends on public services). Polite: 2 Nominatim calls through the
// app's 1 req/s queue and ONE small Overpass query through the app's endpoint fallback.
//
//   node tools/test/net.mjs

import { openApp, makeChecker } from './lib.mjs';

const { check, finish } = makeChecker('net');
const { browser, page, errors } = await openApp({ lang: 'es', fixtures: 'all' });
const r = await page.evaluate(async () => {
  const out = { origin: location.origin, protocol: location.protocol, endpoints: MT.geo.overpassEndpoints() };
  const t0 = performance.now();
  try {
    const res = await MT.geo.search('Av. José Larco 345, Miraflores');
    out.search = { n: res.length, first: res[0] && { lat: res[0].lat, lng: res[0].lng, label: res[0].label } };
  } catch (e) { out.search = { error: String(e) }; }
  try {
    const rev = await MT.geo.reverse(-12.1219, -77.0297);
    out.reverse = rev && { street: rev.street, district: rev.district };
  } catch (e) { out.reverse = { error: String(e) }; }
  out.nominatimMs = Math.round(performance.now() - t0);
  const statuses = [];
  const t1 = performance.now();
  try {
    const q = '[out:json][timeout:25];nwr["shop"="supermarket"](-12.125,-77.035,-12.115,-77.025);out center tags 20;';
    const res = await MT.geo.overpass(q, { onStatus: (s) => statuses.push(s) });
    out.overpass = { endpoint: res.endpoint, timestamp: res.timestamp, elements: res.json.elements.length };
  } catch (e) { out.overpass = { error: String(e), details: e.details }; }
  out.overpassMs = Math.round(performance.now() - t1);
  out.statuses = statuses;
  return out;
});
console.log(JSON.stringify(r, null, 2));
check(r.search && r.search.n > 0, 'Nominatim search via MT.geo.search from file://');
check(r.reverse && !r.reverse.error, 'Nominatim reverse via MT.geo.reverse from file://');
check(r.nominatimMs >= 1000, `requests were spaced ≥1 s apart (${r.nominatimMs} ms for 2 calls)`);
check(r.overpass && !r.overpass.error, `Overpass via MT.geo.overpass (${r.overpass && (r.overpass.endpoint || r.overpass.error)})`);
console.log('console errors (expected only for rejected Overpass endpoints):', errors);
await browser.close();
finish();
