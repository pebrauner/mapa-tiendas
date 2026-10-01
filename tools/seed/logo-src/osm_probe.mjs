// One Overpass query (Peru) to see how the 8 chains are tagged in OSM, to tune nameRegex / shops.
import fs from "node:fs";
const UA = "mapa-tiendas-seed/1.0 (github.com/pebrauner/mapa-tiendas)";
const q = `[out:json][timeout:240];
area["ISO3166-1"="PE"][admin_level=2]->.pe;
(
  nwr[~"^(name|brand|operator|name:es)$"~"plaza ?vea|tottus|wong|metro|vivanda|mass|precio ?uno|hiperbodega|makro",i](area.pe);
  nwr["brand:wikidata"~"^(Q7203672|Q7828510|Q28604866|Q16640217|Q7937539|Q104814825|Q109657737|Q704606)$"](area.pe);
);
out tags center;`;
const endpoints = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"];
for (const ep of endpoints) {
  try {
    const r = await fetch(ep, { method: "POST", headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded" }, body: "data=" + encodeURIComponent(q) });
    const t = await r.text();
    if (!r.ok || !t.startsWith("{")) { console.log("fail", ep, r.status, t.slice(0, 200)); continue; }
    fs.writeFileSync("osm_probe.json", t);
    console.log("ok", ep, JSON.parse(t).elements.length);
    break;
  } catch (e) { console.log("err", ep, e.message); }
}
