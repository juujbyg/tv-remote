import dgram from 'node:dgram';
import net from 'node:net';
import os from 'node:os';
import { execFile } from 'node:child_process';

/** Resolve after `ms`, or reject with `message` if `promise` is still pending. */
export function withTimeout(promise, ms, message = 'Timed out') {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); }),
  ]);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** fetch() with a timeout (TVs on a LAN either answer fast or not at all). */
export async function fetchT(url, opts = {}, ms = 2500) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** True if a TCP port accepts connections within `ms`. */
export function portOpen(host, port, ms = 1200) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const done = (ok) => { sock.destroy(); resolve(ok); };
    sock.setTimeout(ms, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

/** Non-internal IPv4 interfaces, best LAN candidates (192.168/10.x) first. */
export function lanAddresses() {
  const out = [];
  let ifaces = {};
  try { ifaces = os.networkInterfaces(); } catch {} // can be denied inside an app sandbox
  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) out.push({ name, address: a.address, netmask: a.netmask });
    }
  }
  const virtual = /vEthernet|WSL|Hyper-V|VirtualBox|VMware|docker|Loopback/i;
  const score = (a) => (virtual.test(a.name) ? 10 : 0) + (a.address.startsWith('192.168.') ? 0 : a.address.startsWith('10.') ? 1 : 2);
  return out.sort((x, y) => score(x) - score(y));
}

function broadcastFor(address, netmask) {
  const a = address.split('.').map(Number);
  const m = netmask.split('.').map(Number);
  return a.map((o, i) => (o & m[i]) | (~m[i] & 255)).join('.');
}

/** Send a Wake-on-LAN magic packet to `mac` on every LAN broadcast address. */
export async function wakeOnLan(mac) {
  const hex = String(mac || '').replace(/[^0-9a-f]/gi, '');
  if (hex.length !== 12) throw new Error('No valid MAC address saved for this TV');
  const macBuf = Buffer.from(hex, 'hex');
  const packet = Buffer.concat([Buffer.alloc(6, 0xff), ...Array(16).fill(macBuf)]);
  const targets = new Set(['255.255.255.255', ...lanAddresses().map((a) => broadcastFor(a.address, a.netmask))]);
  const sock = dgram.createSocket('udp4');
  await new Promise((r) => sock.bind(r));
  sock.setBroadcast(true);
  for (let i = 0; i < 3; i++) {
    for (const t of targets) for (const port of [9, 7]) sock.send(packet, port, t);
    await sleep(100);
  }
  sock.close();
}

/** Look up a device's MAC address in the OS ARP cache (needed for Wake-on-LAN). */
export function arpMac(ip) {
  return new Promise((resolve) => {
    execFile('arp', process.platform === 'win32' ? ['-a', ip] : ['-n', ip], { timeout: 3000 }, (err, out) => {
      const m = !err && String(out).match(/([0-9a-f]{2}[:-]){5}[0-9a-f]{2}/i);
      resolve(m ? m[0].replace(/-/g, ':').toLowerCase() : null);
    });
  });
}

export const xmlTag = (xml, tag) => (xml.match(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`, 'i')) || [])[1]?.trim();
