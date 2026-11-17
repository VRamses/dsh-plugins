process.noAsar = true;
import fs from "node:fs";
const asar = "C:\\Program Files\\DSH Desktop\\resources\\app.asar";
const fd = fs.openSync(asar, "r");
const cab = Buffer.alloc(16); fs.readSync(fd, cab, 0, 16, 0);
const tp = cab.readUInt32LE(8), tj = cab.readUInt32LE(12);
const js = Buffer.alloc(tj); fs.readSync(fd, js, 0, tj, 16);
const arvore = JSON.parse(js.toString("utf8"));
const base = 8 + tp;
const alvos = [];
(function andar(no, pre) { for (const [n, f] of Object.entries(no.files ?? {})) { const c = pre ? pre + "/" + n : n; if (f.files) andar(f, c); else if (c.endsWith("typert.host.js")) alvos.push({ c, o: Number(f.offset), t: f.size }); } })(arvore, "");
for (const a of alvos) { if (a.t > 8000000) continue; const b = Buffer.alloc(a.t); fs.readSync(fd, b, 0, a.t, base + a.o); const txt = b.toString("utf8"); for (const alvo of ["session/page", "session/prompt"]) { const i = txt.indexOf("'" + alvo + "'"); if (i < 0) continue; console.log("### " + alvo + " em " + a.c); console.log(txt.slice(i, i + 900).replace(/\s+/g, " ")); console.log(""); } }
fs.closeSync(fd);
