// Analyze osm_probe.json: group candidate elements per chain keyword, show tag patterns,
// and test the proposed recognition rules (regex + shops + wikidata).
import fs from "node:fs";
const els = JSON.parse(fs.readFileSync("osm_probe.json", "utf8")).elements;
const rules = JSON.parse(fs.readFileSync("osm_rules.json", "utf8"));
const kw = { plazavea: /plaza ?vea/i, tottus: /tottus/i, wong: /wong/i, metro: /metro/i, vivanda: /vivanda/i, mass: /mass/i, preciouno: /precio ?uno|hiperbodega/i, makro: /makro/i };
const only = process.argv[2];
const txt = (t) => [t.name, t.brand, t.operator, t["name:es"]].filter(Boolean).join(" | ");

function matches(rule, t) {
  const wd = t["brand:wikidata"];
  if (wd && rule.wikidata.includes(wd)) return "wikidata";
  const re = new RegExp(rule.nameRegex, "i");
  const nameHit = ["name", "brand", "name:es"].some((k) => t[k] && re.test(t[k]));
  if (!nameHit) return null;
  if (t.shop && rule.shops.includes(t.shop)) return "name+shop";
  return null;
}

for (const [id, k] of Object.entries(kw)) {
  if (only && id !== only) continue;
  const cand = els.filter((e) => k.test(txt(e.tags || {})) || (e.tags || {})["brand:wikidata"] && rules[id].wikidata.includes(e.tags["brand:wikidata"]));
  const shopCount = {};
  for (const e of cand) { const s = e.tags.shop ? "shop=" + e.tags.shop : Object.keys(e.tags).filter((x) => ["amenity", "railway", "public_transport", "highway", "building", "landuse", "office", "leisure", "tourism", "station"].includes(x)).map((x) => x + "=" + e.tags[x]).join(",") || "(none)"; shopCount[s] = (shopCount[s] || 0) + 1; }
  const acc = cand.filter((e) => matches(rules[id], e.tags));
  const rej = cand.filter((e) => !matches(rules[id], e.tags));
  console.log(`\n===== ${id}: candidates ${cand.length}, accepted ${acc.length}, rejected ${rej.length}`);
  console.log("  tag types:", JSON.stringify(shopCount));
  const wdc = {}; for (const e of cand) { const w = e.tags["brand:wikidata"] || "-"; wdc[w] = (wdc[w] || 0) + 1; }
  console.log("  brand:wikidata:", JSON.stringify(wdc));
  const show = (arr, n) => arr.slice(0, n).map((e) => `    ${e.type[0]}${e.id} [${e.tags.shop ? "shop=" + e.tags.shop : Object.entries(e.tags).filter(([a]) => /amenity|railway|public_transport|building|office|leisure|tourism|landuse/.test(a)).map(([a, b]) => a + "=" + b).join(",")}] ${txt(e.tags)}${e.tags["brand:wikidata"] ? " {" + e.tags["brand:wikidata"] + "}" : ""}`).join("\n");
  console.log("  accepted sample:\n" + show(acc, process.argv[3] ? +process.argv[3] : 8));
  console.log("  rejected (all/limited):\n" + show(rej, process.argv[4] ? +process.argv[4] : 40));
}
