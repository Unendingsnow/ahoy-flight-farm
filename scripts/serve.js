/**
 * Zero-dependency static server for web/. Wallets refuse to inject into
 * file:// pages, so the site has to be served over http.
 *
 *   npm run web            -> http://127.0.0.1:8080
 *   PORT=9000 npm run web
 */
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "web");
const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || "127.0.0.1";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

const server = http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || "/").split("?")[0]);
  const rel = url === "/" ? "index.html" : url.replace(/^\/+/, "");
  const file = path.resolve(ROOT, rel);

  // Never serve anything outside web/.
  if (!file.startsWith(path.resolve(ROOT))) {
    res.writeHead(403).end("Forbidden");
    return;
  }

  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        `<pre style="font:14px ui-monospace,monospace;padding:2rem">404 — ${rel}\n\n` +
          `admin.html is gitignored; if it is missing, re-create it or pull it from your own copy.</pre>`
      );
      return;
    }
    res.writeHead(200, {
      "Content-Type": TYPES[path.extname(file).toLowerCase()] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(data);
  });
});

server.listen(PORT, HOST, () => {
  const hasAdmin = fs.existsSync(path.join(ROOT, "admin.html"));
  console.log(`NFT Stake Farm — serving ${path.relative(process.cwd(), ROOT)}`);
  console.log(`  Farm   http://${HOST}:${PORT}/`);
  console.log(`  Admin  http://${HOST}:${PORT}/admin.html${hasAdmin ? "" : "   (missing)"}`);
  console.log("\nCtrl+C to stop.");
});
