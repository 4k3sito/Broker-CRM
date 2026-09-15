#!/usr/bin/env node
// Dev server: sirve web/ y reenvía /api/* al VPS, para poder probar contra datos
// y sesión reales sin desplegar. `npx serve` no sabe hacer proxy y no hay ya una
// librería de proxy instalada — esto es http/fs de stdlib, nada más.
const http = require('http');
const fs = require('fs');
const path = require('path');

const VPS = 'http://31.220.56.100';
const ROOT = path.join(__dirname, 'web');
const TIPOS = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

http.createServer((req, res) => {
  if (req.url.startsWith('/api/')) {
    const upstream = http.request(VPS + req.url, { method: req.method, headers: req.headers }, up => {
      res.writeHead(up.statusCode, up.headers);
      up.pipe(res);
    });
    upstream.on('error', err => { res.writeHead(502); res.end(`Proxy al VPS falló: ${err.message}`); });
    req.pipe(upstream);
    return;
  }

  let ruta = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
  if (ruta.endsWith(path.sep)) ruta += 'index.html';
  if (!ruta.startsWith(ROOT)) { res.writeHead(403); return res.end(); }   // sin ../ fuera de web/
  fs.readFile(ruta, (err, datos) => {
    if (err) { res.writeHead(404); return res.end('No encontrado'); }
    res.writeHead(200, { 'Content-Type': TIPOS[path.extname(ruta)] || 'application/octet-stream' });
    res.end(datos);
  });
}).listen(3000, () => console.log(`http://localhost:3000  (proxy /api -> ${VPS})`));
