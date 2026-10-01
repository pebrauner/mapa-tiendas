// List VTEX custom page routes mentioning stores in a saved HTML page.
import fs from "node:fs";
const s = fs.readFileSync(process.argv[2], "utf8").split("\\u002F").join("/");
const set = new Set();
for (const m of s.matchAll(/store\.custom#([a-z0-9-]+)/gi)) if (/tiend|local|ubic|horar|sede|store/i.test(m[1])) set.add(m[1]);
for (const m of s.matchAll(/"(\/[a-z0-9\/_-]*(?:tienda|locales|ubica|horario)[a-z0-9\/_-]*)"/gi)) set.add(m[1]);
console.log([...set].join("\n") || "(none)");
