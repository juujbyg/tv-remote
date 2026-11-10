// Phone TV Remote bridge: serves the phone web app and relays button presses to TVs on the LAN.
import http from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import QRCode from 'qrcode';

import Roku from './drivers/roku.js';
import Samsung from './drivers/samsung.js';
import Lg from './drivers/lg.js';
import AndroidTv from './drivers/androidtv.js';
import Sony from './drivers/sony.js';
import Demo, { demoBus } from './drivers/demo.js';
import { discover, probe } from './lib/discovery.js';
import { lanAddresses, wakeOnLan, arpMac } from './lib/util.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const DATA_FILE = path.join(process.env.DATA_DIR || path.join(ROOT, 'data'), 'tvs.json');
const PORT = Number(process.env.PORT) || 8787;
const HOST = process.env.HOST || '0.0.0.0'; // the phone app binds to 127.0.0.1

const DRIVERS = Object.fromEntries([AndroidTv, Samsung, Lg, Roku, Sony, Demo].map((D) => [D.brand, D]));

// Keep the bridge alive whatever a TV library does.
process.on('unhandledRejection', (e) => console.warn('[warn]', e?.message || e));
process.on('uncaughtException', (e) => console.warn('[warn]', e?.message || e));

// ---------- storage ----------
let tvs = existsSync(DATA_FILE) ? JSON.parse(readFileSync(DATA_FILE, 'utf8')) : [];
let saveTimer;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    await mkdir(path.dirname(DATA_FILE), { recursive: true });
    await writeFile(DATA_FILE, JSON.stringify(tvs, null, 2));
  }, 50);
}
const publicTv = ({ id, name, brand, ip, mac, model, paired }) => ({ id, name, brand, ip, mac: mac || null, model: model || '', paired: !!paired, brandLabel: DRIVERS[brand]?.label });

const drivers = new Map();
function driverFor(tv) {
  if (!drivers.has(tv.id)) drivers.set(tv.id, new DRIVERS[tv.brand](tv, save));
  return drivers.get(tv.id);
}
function dropDriver(id) { drivers.get(id)?.close(); drivers.delete(id); }

// ---------- http helpers ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}
async function body(req) {
  let raw = '';
  for await (const chunk of req) { raw += chunk; if (raw.length > 1e5) throw new Error('Body too large'); }
  return raw ? JSON.parse(raw) : {};
}
function appUrl() {
  const lan = lanAddresses()[0]?.address || 'localhost';
  return `http://${lan}:${PORT}/`;
}

// ---------- routes ----------
const routes = [
  ['GET', /^\/api\/info$/, async () => ({ url: appUrl(), brands: Object.values(DRIVERS).map((D) => ({ id: D.brand, label: D.label })) })],

  ['GET', /^\/api\/qr\.svg$/, async (req, res) => {
    const svg = await QRCode.toString(appUrl(), { type: 'svg', margin: 1, color: { dark: '#111111', light: '#ffffff' } });
    res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' });
    res.end(svg);
  }],

  ['GET', /^\/api\/tvs$/, async () => tvs.map(publicTv)],

  ['GET', /^\/api\/discover$/, async () => {
    const found = await discover();
    return found.map((f) => ({ ...f, saved: tvs.some((t) => t.ip === f.ip && t.brand === f.brand) }));
  }],

  ['POST', /^\/api\/probe$/, async (req) => {
    const { ip } = await body(req);
    if (!/^[\w.:-]+$/.test(ip || '')) throw httpError(400, 'Enter a valid IP address');
    return probe(ip);
  }],

  ['POST', /^\/api\/tvs$/, async (req) => {
    const { ip, brand, name, psk, mac } = await body(req);
    if (!DRIVERS[brand]) throw httpError(400, 'Pick a TV type');
    if (brand !== 'demo' && !/^[\w.:-]+$/.test(ip || '')) throw httpError(400, 'Enter a valid IP address');
    const tv = { id: randomUUID().slice(0, 8), brand, ip: brand === 'demo' ? '127.0.0.1' : ip, name: (name || '').trim() || `${DRIVERS[brand].label} ${ip || ''}`.trim(), psk, mac, paired: false };
    tvs.push(tv); save();
    return publicTv(tv);
  }],

  ['DELETE', /^\/api\/tvs\/(\w+)$/, async (req, res, id) => {
    dropDriver(id);
    tvs = tvs.filter((t) => t.id !== id); save();
    return { ok: true };
  }],

  ['POST', /^\/api\/tvs\/(\w+)\/pair$/, async (req, res, id) => {
    const tv = findTv(id);
    const { psk } = await body(req);
    if (psk !== undefined) tv.psk = psk;
    dropDriver(id);
    const result = await driverFor(tv).pair();
    if (tv.brand !== 'demo' && !tv.mac) tv.mac = await arpMac(tv.ip);
    if (result.status === 'paired') tv.paired = true;
    save();
    return { ...result, tv: publicTv(tv) };
  }],

  ['POST', /^\/api\/tvs\/(\w+)\/pair-code$/, async (req, res, id) => {
    const tv = findTv(id);
    const { code } = await body(req);
    try {
      const result = await driverFor(tv).pairCode(code);
      tv.paired = true; save();
      return { ...result, tv: publicTv(tv) };
    } catch (e) {
      if (e.retryPair) { dropDriver(id); await driverFor(tv).pair().catch(() => {}); }
      throw e;
    }
  }],

  ['POST', /^\/api\/tvs\/(\w+)\/key$/, async (req, res, id) => {
    const tv = findTv(id);
    const { key } = await body(req);
    if (key === 'power_on') { await wakeOnLan(tv.mac); return { ok: true }; }
    await withRetry(tv, (d) => d.key(key));
    return { ok: true };
  }],

  ['POST', /^\/api\/tvs\/(\w+)\/text$/, async (req, res, id) => {
    const tv = findTv(id);
    const { text } = await body(req);
    await withRetry(tv, (d) => d.text(String(text || '')));
    return { ok: true };
  }],

  ['POST', /^\/api\/tvs\/(\w+)\/app$/, async (req, res, id) => {
    const tv = findTv(id);
    const { app } = await body(req);
    await withRetry(tv, (d) => d.app(app));
    return { ok: true };
  }],

  // Live feed for the virtual test TV page.
  ['GET', /^\/api\/demo\/events$/, async (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write(': hi\n\n');
    const onEvent = (e) => res.write(`data: ${JSON.stringify(e)}\n\n`);
    demoBus.on('event', onEvent);
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => { demoBus.off('event', onEvent); clearInterval(ping); });
  }],
];

function httpError(status, message) { return Object.assign(new Error(message), { status }); }
function findTv(id) {
  const tv = tvs.find((t) => t.id === id);
  if (!tv) throw httpError(404, 'TV not found');
  return tv;
}
/** A TV may have dropped the connection (sleep, Wi-Fi blip): reconnect once and retry. */
async function withRetry(tv, fn) {
  try { return await fn(driverFor(tv)); }
  catch (e) {
    if (e.needsPair) throw httpError(409, 'This TV needs pairing');
    if (/not supported|not available|Wrong|denied|refused/i.test(e.message)) throw e;
    dropDriver(tv.id);
    return fn(driverFor(tv));
  }
}

async function serveStatic(req, res) {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = path.normalize(path.join(PUBLIC, urlPath === '/' ? 'index.html' : urlPath));
  if (!file.startsWith(PUBLIC)) return send(res, 403, { error: 'Forbidden' });
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  } catch {
    send(res, 404, { error: 'Not found' });
  }
}

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://x');
  if (!pathname.startsWith('/api/')) return serveStatic(req, res);
  for (const [method, re, handler] of routes) {
    const m = pathname.match(re);
    if (!m || req.method !== method) continue;
    try {
      const result = await handler(req, res, ...m.slice(1));
      if (!res.headersSent) send(res, 200, result);
    } catch (e) {
      const unreachable = ['ECONNREFUSED', 'EHOSTUNREACH', 'ETIMEDOUT', 'ENETUNREACH'].includes(e.code || e.cause?.code)
        || e.name === 'AbortError' || e.message === 'fetch failed';
      const msg = unreachable ? 'Could not reach the TV. Is it on?' : e.message || String(e);
      console.warn(`[${req.method} ${pathname}]`, msg);
      if (!res.headersSent) send(res, e.status || 502, { error: msg });
    }
    return;
  }
  send(res, 404, { error: 'Unknown endpoint' });
});

server.on('error', (e) => {
  console.error(e.code === 'EADDRINUSE' ? `Port ${PORT} is already in use (is the remote already running?). Use PORT=xxxx to pick another.` : e);
  process.exit(1);
});

server.listen(PORT, HOST, async () => {
  if (HOST === '127.0.0.1') return console.log(`TV Remote service on http://127.0.0.1:${PORT}/`);
  const url = appUrl();
  console.log('\n  📺  Phone TV Remote is running\n');
  console.log(`  On your phone (same Wi-Fi): ${url}`);
  console.log(`  On this PC:                 http://localhost:${PORT}/`);
  console.log(`  Test TV screen:             http://localhost:${PORT}/tv.html\n`);
  try { console.log(await QRCode.toString(url, { type: 'terminal', small: true })); } catch {}
  console.log('  Scan the QR code with your phone camera. Press Ctrl+C to stop.\n');
});
