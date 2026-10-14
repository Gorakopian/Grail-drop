// Local test server only (Vercel does not use this file): `npm run dev`, then open http://localhost:3000
import http from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const envPath = new URL(".env", root);
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
const routes = Object.fromEntries(["auth", "state", "enter", "claim", "admin", "proof"].map((n) => [`/api/${n}`, () => import(`../api/${n}.js`)]));
const port = Number(process.env.PORT) || 3000;
http.createServer(async (req, res) => {
  try {
    const path = req.url.split("?")[0];
    if (routes[path]) return (await routes[path]()).default(req, res);
    if (path === "/" || path === "/index.html") {
      res.setHeader("content-type", "text/html; charset=utf-8");
      return res.end(await readFile(new URL("index.html", root)));
    }
    res.statusCode = 404; res.end("Not found");
  } catch (e) { console.error(e); res.statusCode = 500; res.end("Server error"); }
}).listen(port, () => console.log(`GRAIL DROP on http://localhost:${port}`));
