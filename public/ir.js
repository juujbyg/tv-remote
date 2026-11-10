// Infrared through the headphone jack.
//
// Wiring: two IR LEDs in anti-parallel (one each way) between the LEFT and RIGHT contacts of a
// 3.5 mm plug (ground unused). We play carrier/2 Hz on the left channel and its inverse on the right:
// the voltage across the LEDs swings ±, each LED lights on alternate half-cycles, so together they
// flash at the full carrier (36-40 kHz) — above what a 48 kHz audio output can play directly.
//
// Pure module (no DOM) so it can be tested in Node.

// ---------- protocol encoders: return { carrier, pulses: [mark, space, mark, ...] µs, repeat, gap } ----------
const lsbBits = (value, n) => Array.from({ length: n }, (_, i) => (value >> i) & 1);
const msbBits = (value, n) => Array.from({ length: n }, (_, i) => (value >> (n - 1 - i)) & 1);

function pulseDistance(header, bits, one, zero, mark, stop = true) {
  const p = [...header];
  for (const b of bits) p.push(mark, b ? one : zero);
  if (stop) p.push(mark);
  return p;
}

const ENCODERS = {
  // NEC: 8-bit address (+inverse) or 16-bit "extended" address, 8-bit command (+inverse)
  nec({ address, command }) {
    const addrBits = address > 0xff ? lsbBits(address, 16) : [...lsbBits(address, 8), ...lsbBits(~address & 0xff, 8)];
    const bits = [...addrBits, ...lsbBits(command, 8), ...lsbBits(~command & 0xff, 8)];
    return { carrier: 38000, pulses: pulseDistance([9000, 4500], bits, 1690, 560, 560), repeat: 1, gap: 40000 };
  },
  samsung32({ address, command }) {
    const bits = [...lsbBits(address, 8), ...lsbBits(address, 8), ...lsbBits(command, 8), ...lsbBits(~command & 0xff, 8)];
    return { carrier: 38000, pulses: pulseDistance([4500, 4500], bits, 1690, 560, 560), repeat: 1, gap: 46000 };
  },
  // Sony SIRC 12/15/20-bit: pulse-width coded, sent 3 times (the TV ignores fewer).
  sirc({ address, command, bits: n = 12 }) {
    const addrLen = n === 15 ? 8 : n === 20 ? 13 : 5;
    const bits = [...lsbBits(command, 7), ...lsbBits(address, addrLen)];
    const out = [2400]; // header mark, then (space 600, mark 1200|600) per bit
    for (const b of bits) out.push(600, b ? 1200 : 600);
    const frameLen = out.reduce((a, b) => a + b, 0);
    return { carrier: 40000, pulses: out, repeat: 3, gap: Math.max(10000, 45000 - frameLen) };
  },
  // Panasonic (Kaseikyo 48-bit): vendor 0x2002, device, subdevice, command, parity.
  panasonic({ address = 0x80, sub = 0x00, command }) {
    const bytes = [0x02, 0x20, address, sub, command, address ^ sub ^ command];
    const bits = bytes.flatMap((b) => lsbBits(b, 8));
    return { carrier: 37000, pulses: pulseDistance([3456, 1728], bits, 1296, 432, 432), repeat: 1, gap: 74000 };
  },
  // Philips RC5: Manchester, 889 µs half-bits, toggle bit flips on each new press.
  rc5({ address, command }, toggle) {
    const bits = [1, command < 64 ? 1 : 0, toggle, ...msbBits(address, 5), ...msbBits(command & 63, 6)];
    const levels = bits.flatMap((b) => (b ? [0, 1] : [1, 0])); // 1 = space→mark
    return { carrier: 36000, pulses: levelsToPulses(levels, 889), repeat: 1, gap: 89000 };
  },
  // Philips RC6 mode 0: leader, start bit, 3 mode bits, double-width toggle, 8-bit address, 8-bit command.
  rc6({ address, command }, toggle) {
    const T = 444;
    const levels = [1, 1, 1, 1, 1, 1, 0, 0]; // leader 6T mark, 2T space
    const bit = (b, w = 1) => { for (let i = 0; i < w; i++) levels.push(b ? 1 : 0); for (let i = 0; i < w; i++) levels.push(b ? 0 : 1); };
    bit(1); bit(0); bit(0); bit(0); bit(toggle, 2);
    for (const b of [...msbBits(address, 8), ...msbBits(command, 8)]) bit(b);
    return { carrier: 36000, pulses: levelsToPulses(levels, T), repeat: 1, gap: 2664 * 10 };
  },
};

/** [1,1,0,1,...] half-bit levels → [mark, space, ...] (must start with a mark). */
function levelsToPulses(levels, unit) {
  while (levels[0] === 0) levels.shift();
  while (levels[levels.length - 1] === 0) levels.pop();
  const out = [];
  let cur = 1, run = 0;
  for (const l of levels) {
    if (l === cur) run += unit;
    else { out.push(run); cur = l; run = unit; }
  }
  out.push(run);
  return out;
}

/** Pronto hex ("0000 006D 0022 0002 0157 00AC ...") → signal. Works with codes from any IR database. */
export function parsePronto(text) {
  const w = String(text).trim().split(/\s+/).map((h) => parseInt(h, 16));
  if (w.length < 6 || w.some(Number.isNaN) || w[0] !== 0) throw new Error('Not a raw Pronto code (must start with 0000)');
  const carrier = 1e6 / (w[1] * 0.241246);
  const [n1, n2] = [w[2], w[3]];
  const once = w.slice(4, 4 + n1 * 2), rep = w.slice(4 + n1 * 2, 4 + (n1 + n2) * 2);
  const seq = (once.length ? once : rep).map((c) => Math.round((c * 1e6) / carrier));
  if (!seq.length || seq.length % 2) throw new Error('Pronto code has the wrong length');
  const gap = seq.pop(); // trailing space is the inter-frame gap
  return { carrier, pulses: seq, repeat: once.length ? 1 : 2, gap: Math.max(gap, 10000) };
}

// ---------- code sets ----------
const nec = (address, map) => ({ protocol: 'nec', address, map });
const digits = (f) => Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`num_${i}`, f(i)]));

export const PRESETS = {
  samsung: {
    label: 'Samsung', protocol: 'samsung32', address: 0x07,
    map: {
      power: 0x02, power_off: 0x98, vol_up: 0x07, vol_down: 0x0b, mute: 0x0f, ch_up: 0x12, ch_down: 0x10,
      up: 0x60, down: 0x61, left: 0x65, right: 0x62, ok: 0x68, back: 0x58, menu: 0x1a, settings: 0x1a, home: 0x79,
      input: 0x01, exit: 0x2d, info: 0x1f, guide: 0x4f, play: 0x47, play_pause: 0x47, pause: 0x4a, stop: 0x46,
      rewind: 0x45, ffwd: 0x48, red: 0x6c, green: 0x14, yellow: 0x15, blue: 0x16,
      ...digits((i) => [0x11, 0x04, 0x05, 0x06, 0x08, 0x09, 0x0a, 0x0c, 0x0d, 0x0e][i]),
    },
  },
  lg: {
    label: 'LG (also many Vizio)', ...nec(0x04, {
      power: 0x08, vol_up: 0x02, vol_down: 0x03, mute: 0x09, ch_up: 0x00, ch_down: 0x01,
      up: 0x40, down: 0x41, left: 0x07, right: 0x06, ok: 0x44, back: 0x28, home: 0x7c, menu: 0x43, settings: 0x43,
      input: 0x0b, exit: 0x5b, info: 0xaa, guide: 0xab, play: 0xb0, play_pause: 0xb0, pause: 0xba, stop: 0xb1,
      rewind: 0x8f, ffwd: 0x8e, red: 0x72, green: 0x71, yellow: 0x63, blue: 0x61,
      ...digits((i) => 0x10 + i),
    }),
  },
  sony: {
    label: 'Sony', protocol: 'sirc', address: 0x01, bits: 12,
    map: {
      power: 0x15, power_off: 0x2f, vol_up: 0x12, vol_down: 0x13, mute: 0x14, ch_up: 0x10, ch_down: 0x11,
      up: 0x74, down: 0x75, left: 0x34, right: 0x33, ok: 0x65, home: 0x60, menu: 0x60, info: 0x3a, guide: 0x0e, input: 0x25,
      // Bravia extras live on the 15-bit device 0x97
      back: { bits: 15, address: 0x97, command: 0x23 }, settings: { bits: 15, address: 0x97, command: 0x36 },
      play: { bits: 15, address: 0x97, command: 0x1a }, play_pause: { bits: 15, address: 0x97, command: 0x1a },
      pause: { bits: 15, address: 0x97, command: 0x19 }, stop: { bits: 15, address: 0x97, command: 0x18 },
      rewind: { bits: 15, address: 0x97, command: 0x1b }, ffwd: { bits: 15, address: 0x97, command: 0x1c },
      red: { bits: 15, address: 0x97, command: 0x25 }, green: { bits: 15, address: 0x97, command: 0x26 },
      yellow: { bits: 15, address: 0x97, command: 0x27 }, blue: { bits: 15, address: 0x97, command: 0x24 },
      ...digits((i) => (i === 0 ? 0x09 : i - 1)),
    },
  },
  panasonic: {
    label: 'Panasonic', protocol: 'panasonic', address: 0x80,
    map: {
      power: 0x3d, vol_up: 0x20, vol_down: 0x21, mute: 0x32, ch_up: 0x34, ch_down: 0x35, input: 0x05,
      up: 0x4a, down: 0x4b, left: 0x4e, right: 0x4f, ok: 0x49, menu: 0x06, back: 0x2b,
      ...digits((i) => (i === 0 ? 0x19 : 0x0f + i)),
    },
  },
  toshiba: {
    label: 'Toshiba', ...nec(0x40, {
      power: 0x12, vol_up: 0x1a, vol_down: 0x1e, mute: 0x10, ch_up: 0x1b, ch_down: 0x1f, input: 0x0f,
      ...digits((i) => i),
    }),
  },
  philips: {
    label: 'Philips (newer, RC6)', protocol: 'rc6', address: 0x00,
    map: {
      power: 0x0c, mute: 0x0d, vol_up: 0x10, vol_down: 0x11, ch_up: 0x4c, ch_down: 0x4d,
      up: 0x58, down: 0x59, left: 0x5a, right: 0x5b, ok: 0x5c, back: 0x0a, home: 0x54, info: 0x0f, input: 0x38,
      play: 0x2c, play_pause: 0x2c, pause: 0x30, stop: 0x31, rewind: 0x29, ffwd: 0x28,
      red: 0x6d, green: 0x6e, yellow: 0x6f, blue: 0x70,
      ...digits((i) => i),
    },
  },
  philips_old: {
    label: 'Philips (older, RC5)', protocol: 'rc5', address: 0x00,
    map: {
      power: 0x0c, mute: 0x0d, vol_up: 0x10, vol_down: 0x11, ch_up: 0x20, ch_down: 0x21,
      up: 0x50, down: 0x51, left: 0x55, right: 0x56, ok: 0x57,
      ...digits((i) => i),
    },
  },
};

const toggles = {};

/** Resolve a button on a preset (plus the user's Pronto overrides) to a signal, or null. */
export function signalFor(presetId, key, overrides = {}) {
  if (overrides[key]) return parsePronto(overrides[key]);
  const preset = PRESETS[presetId];
  if (!preset) return null;
  let entry = preset.map[key];
  if (entry === undefined && key === 'play_pause') entry = preset.map.play;
  if (entry === undefined && key === 'power_off') entry = preset.map.power;
  if (entry === undefined) return null;
  const params = { address: preset.address, bits: preset.bits, ...(typeof entry === 'object' ? entry : { command: entry }) };
  const t = (toggles[presetId] = toggles[presetId] ? 0 : 1);
  return ENCODERS[preset.protocol](params, t);
}

export const supportedKeys = (presetId, overrides = {}) => new Set([...Object.keys(PRESETS[presetId]?.map || {}), ...Object.keys(overrides)]);

// ---------- audio rendering ----------
/**
 * Render a signal as stereo samples. Returns { left, right } Float32Arrays.
 * Marks carry a carrier/2 sine on L and its inverse on R; spaces are silent.
 */
export function render(signal, sampleRate = 48000, { leadIn = 0.03, tail = 0.02, amplitude = 1 } = {}) {
  const { carrier, pulses, repeat = 1, gap = 40000 } = signal;
  const frameUs = pulses.reduce((a, b) => a + b, 0);
  const totalUs = leadIn * 1e6 + repeat * frameUs + (repeat - 1) * gap + tail * 1e6;
  const n = Math.ceil((totalUs / 1e6) * sampleRate);
  const left = new Float32Array(n), right = new Float32Array(n);
  const w = (2 * Math.PI * (carrier / 2)) / sampleRate;
  let t = leadIn * 1e6;
  for (let r = 0; r < repeat; r++) {
    pulses.forEach((d, i) => {
      if (i % 2 === 0) {
        const a = Math.round((t / 1e6) * sampleRate), b = Math.round(((t + d) / 1e6) * sampleRate);
        for (let s = a; s < b && s < n; s++) {
          const v = amplitude * Math.sin(w * (s - a)); // phase restarts with each mark
          left[s] = v; right[s] = -v;
        }
      }
      t += d;
    });
    t += gap;
  }
  return { left, right };
}

// ---------- playback (browser) ----------
let ctx;
export async function transmit(signal) {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) throw new Error('this browser has no Web Audio');
  if (!ctx) { try { ctx = new AC({ sampleRate: 48000 }); } catch { ctx = new AC(); } }
  if (ctx.state === 'suspended') await ctx.resume();
  if (signal.carrier / 2 >= ctx.sampleRate / 2) throw new Error(`Audio output too slow (${ctx.sampleRate} Hz)`);
  const { left, right } = render(signal, ctx.sampleRate);
  const buf = ctx.createBuffer(2, left.length, ctx.sampleRate);
  buf.copyToChannel(left, 0);
  buf.copyToChannel(right, 1);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  src.start();
  return new Promise((r) => (src.onended = r));
}

/** Power codes tried, one by one, by the "find my TV" search. */
export const POWER_SEARCH = Object.keys(PRESETS).filter((id) => PRESETS[id].map.power !== undefined);
