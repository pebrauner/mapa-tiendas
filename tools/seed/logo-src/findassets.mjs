// usage: node findassets.mjs file.html "regex-filter"
import fs from "node:fs";
const [, , file, filt] = process.argv;
const s = fs.readFileSync(file, "utf8").split("\\u002F").join("/").split("\\/").join("/");
const re = /(https?:\/\/|\/)[^"'()\s<>]*?\.(svg|png|webp|jpg|jpeg)/gi;
const set = new Set();
let m;
const f = new RegExp(filt || ".", "i");
while ((m = re.exec(s))) if (f.test(m[0])) set.add(m[0]);
console.log([...set].join("\n"));
