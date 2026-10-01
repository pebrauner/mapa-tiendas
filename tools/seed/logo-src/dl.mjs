import fs from "node:fs";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36 mapa-tiendas-seed/1.0 (github.com/pebrauner/mapa-tiendas)";
const list = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const log = fs.existsSync("downloads.json") ? JSON.parse(fs.readFileSync("downloads.json", "utf8")) : {};
for (const [id, name, url] of list) {
  fs.mkdirSync(id, { recursive: true });
  const out = `${id}/${name}`;
  try {
    const r = await fetch(url, { headers: { "User-Agent": url.includes("wikimedia") ? "mapa-tiendas-seed/1.0 (github.com/pebrauner/mapa-tiendas)" : UA } });
    const b = Buffer.from(await r.arrayBuffer());
    if (!r.ok) { console.log("FAIL", r.status, out, url); continue; }
    fs.writeFileSync(out, b);
    log[out] = { url, status: r.status, type: r.headers.get("content-type"), bytes: b.length, fetched: new Date().toISOString() };
    console.log("ok", out, r.headers.get("content-type"), b.length);
  } catch (e) { console.log("ERR", out, e.message); }
  await new Promise(r => setTimeout(r, 700));
}
fs.writeFileSync("downloads.json", JSON.stringify(log, null, 1));
