// usage: node svg2png.mjs in.svg out.png [width]
// Rasterizes an SVG with headless Chrome on a transparent background.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const [, , inp, out, wArg] = process.argv;
const svg = fs.readFileSync(inp, "utf8");
let w, h;
const vb = svg.match(/viewBox\s*=\s*["']\s*([-\d.eE]+)[\s,]+([-\d.eE]+)[\s,]+([\d.eE]+)[\s,]+([\d.eE]+)/);
if (vb) { w = +vb[3]; h = +vb[4]; }
else {
  const mw = svg.match(/<svg[^>]*\swidth=["']([\d.]+)/), mh = svg.match(/<svg[^>]*\sheight=["']([\d.]+)/);
  w = +mw[1]; h = +mh[1];
}
const W = +(wArg || 1600);
const H = Math.round(W * h / w);
const fwd = (p) => path.resolve(p).split(path.sep).join("/");
const html = `<!doctype html><html><head><style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}img{display:block;width:${W}px;height:${H}px}</style></head><body><img src="file:///${fwd(inp)}"></body></html>`;
const tmp = path.resolve(out + ".tmp.html");
fs.writeFileSync(tmp, html);
const chrome = "C:/Program Files/Google/Chrome/Application/chrome.exe";
execFileSync(chrome, [
  "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run",
  `--user-data-dir=${path.resolve("chrome-prof2")}`,
  "--default-background-color=00000000",
  `--window-size=${W},${H}`,
  `--screenshot=${path.resolve(out)}`,
  "file:///" + fwd(tmp),
], { stdio: "ignore", timeout: 60000 });
fs.unlinkSync(tmp);
console.log(out, W + "x" + H, "(svg " + w + "x" + h + ")");
