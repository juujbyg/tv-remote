// Finds TVs on the local network (SSDP + mDNS) and identifies the brand of a given IP.
import dgram from 'node:dgram';
import makeMdns from 'multicast-dns';
import { fetchT, portOpen, lanAddresses, xmlTag } from './util.js';

const SSDP_ADDR = '239.255.255.250';
const SEARCH_TARGETS = ['ssdp:all', 'roku:ecp', 'urn:dial-multiscreen-org:service:dial:1', 'urn:samsung.com:device:RemoteControlReceiver:1', 'urn:lge-com:service:webos-second-screen:1', 'urn:schemas-sony-com:service:IRCC:1'];

function ssdpSearch(ms) {
  const found = new Map(); // ip -> { headers[] }
  const sockets = [];
  return new Promise((resolve) => {
    const ifaces = lanAddresses();
    for (const iface of ifaces.length ? ifaces : [{ address: '0.0.0.0' }]) {
      const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      sockets.push(sock);
      sock.on('error', () => {});
      sock.on('message', (buf, rinfo) => {
        const headers = {};
        for (const line of buf.toString().split(/\r?\n/)) {
          const i = line.indexOf(':');
          if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
        }
        if (!found.has(rinfo.address)) found.set(rinfo.address, []);
        found.get(rinfo.address).push(headers);
      });
      sock.bind(0, iface.address, () => {
        for (const st of SEARCH_TARGETS) {
          const msg = Buffer.from(`M-SEARCH * HTTP/1.1\r\nHOST: ${SSDP_ADDR}:1900\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ${st}\r\n\r\n`);
          sock.send(msg, 1900, SSDP_ADDR, () => {});
        }
      });
    }
    setTimeout(() => { sockets.forEach((s) => { try { s.close(); } catch {} }); resolve(found); }, ms);
  });
}

function mdnsSearch(ms) {
  const found = new Map(); // ip -> name
  return new Promise((resolve) => {
    let mdns;
    try { mdns = makeMdns(); } catch { return resolve(found); }
    mdns.on('error', () => {});
    mdns.on('response', (res, rinfo) => {
      const records = [...res.answers, ...res.additionals];
      const ptr = records.find((r) => r.type === 'PTR' && r.name === '_androidtvremote2._tcp.local');
      if (!ptr) return;
      const a = records.find((r) => r.type === 'A');
      const ip = a?.data || rinfo.address;
      found.set(ip, String(ptr.data).replace('._androidtvremote2._tcp.local', ''));
    });
    const ask = () => mdns.query({ questions: [{ name: '_androidtvremote2._tcp.local', type: 'PTR' }] });
    ask(); setTimeout(ask, 700);
    setTimeout(() => { try { mdns.destroy(); } catch {} resolve(found); }, ms);
  });
}

function classifySsdp(headers) {
  const all = headers.map((h) => `${h.server || ''} ${h.st || ''} ${h.usn || ''}`).join(' ').toLowerCase();
  if (all.includes('roku')) return 'roku';
  if (all.includes('webos') || all.includes('lge')) return 'lg';
  if (all.includes('samsung') || all.includes('tizen')) return 'samsung';
  if (all.includes('sony')) return 'sony';
  return null;
}

async function friendlyName(location) {
  try {
    const xml = await (await fetchT(location, {}, 2000)).text();
    return { name: xmlTag(xml, 'friendlyName'), model: xmlTag(xml, 'modelName'), maker: xmlTag(xml, 'manufacturer') };
  } catch { return {}; }
}

/** Scan the LAN. Returns [{ ip, brand, name, model }]. */
export async function discover(ms = 3500) {
  const [ssdp, mdns] = await Promise.all([ssdpSearch(ms), mdnsSearch(ms)]);
  const results = new Map();

  await Promise.all([...ssdp].map(async ([ip, headers]) => {
    let brand = classifySsdp(headers);
    const loc = headers.find((h) => h.location)?.location;
    const info = loc ? await friendlyName(loc) : {};
    if (!brand && /samsung/i.test(info.maker || '')) brand = 'samsung';
    if (!brand && /lg/i.test(info.maker || '')) brand = 'lg';
    if (!brand && /sony/i.test(info.maker || '')) brand = 'sony';
    if (!brand) return; // routers, printers, speakers...
    results.set(ip, { ip, brand, name: info.name || `${brand} TV`, model: info.model || '' });
  }));

  // Google/Android TVs answer on mDNS; this protocol needs no setting changes, so it wins over Sony IRCC.
  for (const [ip, name] of mdns) {
    const prev = results.get(ip);
    if (!prev || prev.brand === 'sony') results.set(ip, { ip, brand: 'androidtv', name: prev?.name || name, model: prev?.model || '' });
  }
  return [...results.values()].sort((a, b) => a.ip.localeCompare(b.ip, undefined, { numeric: true }));
}

/** Work out which protocol a TV at `ip` speaks. */
export async function probe(ip) {
  const checks = await Promise.all([
    fetchT(`http://${ip}:8060/query/device-info`, {}, 2000).then(async (r) => {
      if (!r.ok) return null;
      const xml = await r.text();
      return { brand: 'roku', name: xmlTag(xml, 'user-device-name') || xmlTag(xml, 'friendly-device-name'), model: xmlTag(xml, 'model-name') };
    }).catch(() => null),
    fetchT(`http://${ip}:8001/api/v2/`, {}, 2000).then(async (r) => { const j = await r.json(); return j?.device && { brand: 'samsung', name: j.device.name, model: j.device.modelName }; }).catch(() => null),
    portOpen(ip, 6466).then((ok) => ok && { brand: 'androidtv' }),
    Promise.all([portOpen(ip, 3000), portOpen(ip, 3001)]).then(([a, b]) => (a || b) && { brand: 'lg' }),
    fetchT(`http://${ip}/sony/system`, { method: 'POST', body: JSON.stringify({ method: 'getInterfaceInformation', params: [], id: 1, version: '1.0' }) }, 2000)
      .then(async (r) => { const j = await r.json(); return j?.result && { brand: 'sony', name: j.result[0]?.modelName, model: j.result[0]?.modelName }; }).catch(() => null),
  ]);
  const order = ['roku', 'samsung', 'lg', 'androidtv', 'sony'];
  const hits = checks.filter(Boolean).sort((a, b) => order.indexOf(a.brand) - order.indexOf(b.brand));
  return hits[0] ? { ip, ...hits[0], alternatives: hits.map((h) => h.brand) } : { ip, brand: null };
}
