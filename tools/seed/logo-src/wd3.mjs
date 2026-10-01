import fs from "node:fs";
const UA = "mapa-tiendas-seed/1.0 (github.com/pebrauner/mapa-tiendas)";
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ids = process.argv.slice(2);
fs.mkdirSync("wd", { recursive: true });
for (const id of ids) {
  if (fs.existsSync(`wd/${id}.json`)) continue;
  for (let attempt = 0; attempt < 8; attempt++) {
    const r = await fetch(`https://www.wikidata.org/wiki/Special:EntityData/${id}.json`, { headers: { "User-Agent": UA, "Accept": "application/json" } });
    const t = await r.text();
    if (r.ok && t.startsWith("{")) { fs.writeFileSync(`wd/${id}.json`, t); console.log("ok", id); break; }
    console.log("retry", id, r.status, t.slice(0, 60).replace(/\n/g, " "));
    await sleep(15000 * (attempt + 1));
  }
  await sleep(5000);
}
console.log("done");
