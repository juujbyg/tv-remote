// Renders every IR code to audio, then demodulates it like a TV's IR receiver would and checks
// that the pulse train and the decoded bits match. Run: node test/ir.test.mjs
import assert from 'node:assert/strict';
import { PRESETS, signalFor, render, parsePronto } from '../public/ir.js';

const RATE = 48000;

/** LED current flows when |L-R| clears the forward voltage; smooth over one carrier period. */
function demodulate({ left, right }, carrier) {
  // Window = one period of the per-LED tone (carrier/2), centred, like the DAC's smooth reconstruction.
  const half = Math.ceil(RATE / carrier);
  const on = Array.from(left, (l, i) => Math.abs(l - right[i]) > 0.9);
  const env = on.map((_, i) => on.slice(Math.max(0, i - half + 1), i + half).some(Boolean));
  const runs = [];
  let cur = env[0], len = 0;
  for (const e of env) { if (e === cur) len++; else { runs.push({ mark: cur, us: (len / RATE) * 1e6 }); cur = e; len = 1; } }
  runs.push({ mark: cur, us: (len / RATE) * 1e6 });
  return runs.filter((r, i) => !(i === 0 && !r.mark)).slice(0, -1); // drop lead-in and tail silence
}

function checkPulses(sig, label) {
  const runs = demodulate(render(sig, RATE), sig.carrier);
  const expected = [];
  for (let r = 0; r < sig.repeat; r++) { expected.push(...sig.pulses); if (r < sig.repeat - 1) expected.push(sig.gap); }
  assert.equal(runs.length, expected.length, `${label}: pulse count`);
  runs.forEach((r, i) => {
    assert.equal(r.mark, i % 2 === 0, `${label}: pulse ${i} level`);
    assert.ok(Math.abs(r.us - expected[i]) < 90, `${label}: pulse ${i} is ${r.us.toFixed(0)}µs, want ${expected[i]}`);
  });
  return runs;
}

function decodeNecLike(runs) {
  const bits = [];
  for (let i = 2; i + 1 < runs.length && bits.length < 32; i += 2) bits.push(runs[i + 1].us > 1100 ? 1 : 0);
  const byte = (k) => bits.slice(k * 8, k * 8 + 8).reduce((a, b, j) => a | (b << j), 0);
  return [0, 1, 2, 3].map(byte);
}

let checked = 0;
for (const [id, preset] of Object.entries(PRESETS)) {
  for (const key of Object.keys(preset.map)) {
    const sig = signalFor(id, key);
    assert.ok(sig.carrier / 2 < RATE / 2, `${id}.${key}: carrier fits the audio band`);
    const runs = checkPulses(sig, `${id}.${key}`);
    if (preset.protocol === 'nec' || preset.protocol === 'samsung32') {
      const [a, a2, c, c2] = decodeNecLike(runs);
      assert.equal(a, preset.address, `${id}.${key} address`);
      assert.equal(a2, preset.protocol === 'nec' ? (~preset.address & 0xff) : preset.address);
      assert.equal(c, preset.map[key], `${id}.${key} command`);
      assert.equal(c2, ~preset.map[key] & 0xff, `${id}.${key} inverse`);
    }
    if (preset.protocol === 'sirc') {
      const entry = typeof preset.map[key] === 'object' ? preset.map[key] : { command: preset.map[key], address: 1, bits: 12 };
      const bits = [];
      for (let i = 1; i < runs.length && bits.length < entry.bits; i += 2) bits.push(runs[i + 1].us > 900 ? 1 : 0);
      const cmd = bits.slice(0, 7).reduce((a, b, j) => a | (b << j), 0);
      const addr = bits.slice(7).reduce((a, b, j) => a | (b << j), 0);
      assert.deepEqual([cmd, addr], [entry.command, entry.address], `${id}.${key} SIRC decode`);
    }
    checked++;
  }
}

// Pronto import: a known-good NEC Pronto (LG power, address 0x04 command 0x08).
const lgPower = signalFor('lg', 'power');
const words = ['0000', '006D', (lgPower.pulses.length / 2 + 0.5 | 0).toString(16).padStart(4, '0'), '0000'];
const unit = 0.241246 * 0x6d;
for (const d of [...lgPower.pulses, lgPower.gap]) words.push(Math.round(d / unit).toString(16).padStart(4, '0'));
const parsed = parsePronto(words.join(' '));
assert.ok(Math.abs(parsed.carrier - 38029) < 100, 'pronto carrier');
assert.deepEqual(decodeNecLike(checkPulses(parsed, 'pronto')), [0x04, 0xfb, 0x08, 0xf7], 'pronto decodes to LG power');
assert.throws(() => parsePronto('hello'));

console.log(`IR OK: ${checked} codes across ${Object.keys(PRESETS).length} brands + Pronto import`);
