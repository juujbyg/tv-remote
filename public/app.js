import * as IR from './ir.js';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

const state = { tvs: [], current: store.get('currentTv', null), brands: [], irTvs: store.get('irTvs', []) };
const currentTv = () => state.tvs.find((t) => t.id === state.current);

// Infrared TVs live only on this phone (no server needed).
const irAsTv = (t) => ({ ...t, brand: 'ir', ir: true, paired: true, ip: 'infrared', brandLabel: `Infrared · ${IR.PRESETS[t.preset]?.label || 'custom codes'}` });
const saveIr = () => store.set('irTvs', state.irTvs);

async function irPress(tv, key) {
  if (key === 'power_on') key = 'power';
  let signal;
  try { signal = IR.signalFor(tv.preset, key, tv.overrides || {}); }
  catch (e) { return toast(`Bad custom code for ${key}: ${e.message}`, true); }
  if (!signal) return toast(`No IR code for “${key.replace(/_/g, ' ')}” in this code set. Add one under Custom IR codes.`, true);
  const btn = $('#tvPicker');
  btn.classList.remove('ir-tx'); void btn.offsetWidth; btn.classList.add('ir-tx');
  try { await IR.transmit(signal); setDot('ready'); }
  catch (e) { setDot('err'); toast(`Audio output failed: ${e.message}`, true); }
}

const PAIR_HINT = {
  samsung: 'Look at your TV and choose <b>Allow</b> when it asks about “Phone Remote”.',
  lg: 'Look at your TV and <b>accept</b> the connection request.',
  androidtv: 'Waiting for the TV to show a pairing code…',
  roku: 'Checking your Roku…',
  sony: 'Checking the Pre-Shared Key…',
  demo: 'Connecting to the test TV…',
};

// ---------- api ----------
async function api(path, body, method) {
  const res = await fetch(`api/${path}`, {
    method: method || (body ? 'POST' : 'GET'),
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Error ${res.status}`), { status: res.status });
  return data;
}

// ---------- feedback ----------
let toastTimer;
function toast(msg, err = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('err', err);
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), err ? 4500 : 2200);
}
const buzz = (ms = 12) => navigator.vibrate?.(ms);
function setDot(s) { $('#statusDot').className = `dot ${s || ''}`; }

// ---------- sending ----------
let inflight = 0;
async function press(key) {
  const tv = currentTv();
  if (!tv) { openSheet('sheetTvs'); return; }
  buzz();
  if (tv.ir) return irPress(tv, key);
  inflight++; if (inflight === 1) setDot('busy');
  try {
    await api(`tvs/${tv.id}/key`, { key });
    setDot('ready');
    if (key === 'power_on') toast('Wake-up signal sent');
  } catch (e) {
    setDot('err');
    if (e.status === 409) return startPair(tv);
    if (key === 'power' && tv.mac && /reach|on\?|answer|timed out/i.test(e.message)) {
      api(`tvs/${tv.id}/key`, { key: 'power_on' }).then(() => toast('TV seems off: sent wake-up signal')).catch(() => toast(e.message, true));
      return;
    }
    toast(e.message, true);
  } finally { inflight--; }
}

// Hold-to-repeat for arrows, volume and channel.
function bindKeys(root = document) {
  for (const el of $$('[data-key]', root)) {
    if (el.dataset.bound) continue;
    el.dataset.bound = 1;
    const key = el.dataset.key;
    if (!('repeat' in el.dataset)) { el.addEventListener('click', () => press(key)); continue; }
    let delay, every;
    const stop = () => { clearTimeout(delay); clearInterval(every); el.classList.remove('pressed'); };
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      el.setPointerCapture?.(e.pointerId);
      el.classList.add('pressed');
      press(key);
      delay = setTimeout(() => { every = setInterval(() => press(key), 140); }, 420);
    });
    ['pointerup', 'pointercancel', 'lostpointercapture'].forEach((ev) => el.addEventListener(ev, stop));
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') press(key); });
  }
}
$('.ok').addEventListener('pointerdown', (e) => e.currentTarget.classList.add('pressed'));
['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => $('.ok').addEventListener(ev, (e) => e.currentTarget.classList.remove('pressed')));

for (const el of $$('[data-app]')) {
  el.addEventListener('click', async () => {
    const tv = currentTv();
    if (!tv) return openSheet('sheetTvs');
    if (tv.ir) return toast('App shortcuts need a Wi-Fi TV', true);
    buzz();
    try { await api(`tvs/${tv.id}/app`, { app: el.dataset.app }); toast(`Opening ${el.textContent}…`); }
    catch (e) { toast(e.message, true); }
  });
}

// ---------- touchpad ----------
const pad = $('#touchpad');
let start = null, lastStep = null;
const STEP = 46;
pad.addEventListener('pointerdown', (e) => {
  pad.setPointerCapture(e.pointerId);
  start = { x: e.clientX, y: e.clientY, t: Date.now(), moved: false };
  lastStep = { x: e.clientX, y: e.clientY };
});
pad.addEventListener('pointermove', (e) => {
  if (!start) return;
  const dx = e.clientX - lastStep.x, dy = e.clientY - lastStep.y;
  if (Math.max(Math.abs(dx), Math.abs(dy)) < STEP) return;
  start.moved = true;
  press(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up'));
  lastStep = { x: e.clientX, y: e.clientY };
});
pad.addEventListener('pointerup', (e) => {
  if (!start) return;
  const dx = e.clientX - start.x, dy = e.clientY - start.y, dist = Math.hypot(dx, dy);
  if (!start.moved) {
    if (dist < 14) {
      const r = $('#ripple'), box = pad.getBoundingClientRect();
      r.style.left = `${e.clientX - box.left}px`; r.style.top = `${e.clientY - box.top}px`;
      r.classList.remove('go'); void r.offsetWidth; r.classList.add('go');
      press('ok');
    } else if (dist > 24) { // short quick flick
      press(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up'));
    }
  }
  start = null;
});
pad.addEventListener('pointercancel', () => (start = null));

function setMode(mode) {
  $$('.mode-toggle button').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
  $('#dpad').hidden = mode !== 'buttons';
  pad.hidden = mode !== 'touch';
  store.set('mode', mode);
}
$$('.mode-toggle button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));

// ---------- sheets ----------
function openSheet(id) {
  $$('.sheet').forEach((s) => (s.hidden = s.id !== id));
  $('#scrim').hidden = false;
  if (id === 'sheetTvs') renderTvList();
}
function closeSheets() {
  $$('.sheet').forEach((s) => (s.hidden = true));
  $('#scrim').hidden = true;
}
$('#scrim').addEventListener('click', closeSheets);
$$('[data-close]').forEach((b) => b.addEventListener('click', closeSheets));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheets(); });
$('#tvPicker').addEventListener('click', () => openSheet('sheetTvs'));
$('#openKeys').addEventListener('click', () => openSheet('sheetKeys'));
$('#openText').addEventListener('click', () => { openSheet('sheetText'); setTimeout(() => $('#textInput').focus(), 50); });

// ---------- TVs ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function renderHeader() {
  const tv = currentTv();
  $('#tvName').textContent = tv ? tv.name : 'Add a TV';
  setDot(tv ? (tv.paired ? 'ready' : '') : '');
}

function renderTvList() {
  const list = $('#tvList');
  if (!state.tvs.length) { list.innerHTML = '<li class="empty">No TVs yet. Scan your network below.</li>'; return; }
  list.innerHTML = state.tvs.map((t) => `
    <li class="${t.id === state.current ? 'current' : ''}">
      <button class="pick" data-pick="${t.id}">
        <svg class="ic"><use href="#i-tv"/></svg>
        <span class="meta"><b>${esc(t.name)}</b><small>${esc(t.brandLabel)} · ${esc(t.ip)}${t.paired ? '' : ' · not connected'}</small></span>
      </button>
      ${t.ir ? `<button class="small-btn" data-codes="${t.id}">Codes</button>` : t.paired ? '' : `<button class="small-btn" data-pair="${t.id}">Connect</button>`}
      <button class="icon-btn" data-del="${t.id}" aria-label="Remove ${esc(t.name)}"><svg class="ic sm"><use href="#i-trash"/></svg></button>
    </li>`).join('');
  $$('[data-pick]', list).forEach((b) => b.addEventListener('click', () => {
    selectTv(b.dataset.pick);
    const tv = currentTv();
    if (tv.paired) closeSheets(); else startPair(tv);
  }));
  $$('[data-pair]', list).forEach((b) => b.addEventListener('click', () => { selectTv(b.dataset.pair); startPair(currentTv()); }));
  $$('[data-del]', list).forEach((b) => b.addEventListener('click', async () => {
    const tv = state.tvs.find((t) => t.id === b.dataset.del);
    if (!confirm(`Remove ${tv.name}?`)) return;
    if (tv.ir) { state.irTvs = state.irTvs.filter((t) => t.id !== tv.id); saveIr(); }
    else await api(`tvs/${tv.id}`, null, 'DELETE');
    await loadTvs();
    renderTvList();
  }));
  $$('[data-codes]', list).forEach((b) => b.addEventListener('click', () => openIrCodes(b.dataset.codes)));
}

function selectTv(id) { state.current = id; store.set('currentTv', id); renderHeader(); }

async function loadTvs() {
  let wifi = [];
  try { wifi = await api('tvs'); state.online = true; } catch { state.online = false; }
  state.tvs = [...wifi, ...state.irTvs.map(irAsTv)];
  if (!currentTv()) state.current = state.tvs[0]?.id ?? null;
  store.set('currentTv', state.current);
  renderHeader();
}

$('#scanBtn').addEventListener('click', async () => {
  const btn = $('#scanBtn'), list = $('#foundList');
  btn.disabled = true; btn.innerHTML = '<span class="spinner" style="width:18px;height:18px;margin:0;border-width:2px"></span> Scanning…';
  list.innerHTML = '';
  try {
    const found = await api('discover');
    list.innerHTML = found.length ? found.map((f, i) => `
      <li>
        <svg class="ic"><use href="#i-tv"/></svg>
        <span class="meta"><b>${esc(f.name)}</b><small>${esc(state.brands.find((b) => b.id === f.brand)?.label)} · ${esc(f.ip)}</small></span>
        ${f.saved ? '<small class="muted">Added</small>' : `<button class="small-btn" data-add="${i}">Add</button>`}
      </li>`).join('')
      : '<li class="empty">No TVs found. Make sure the TV is on and on the same Wi-Fi, or enter its IP below.</li>';
    $$('[data-add]', list).forEach((b) => b.addEventListener('click', () => addTv(found[b.dataset.add])));
  } catch (e) { toast(e.message, true); }
  btn.disabled = false; btn.innerHTML = '<svg class="ic sm"><use href="#i-search"/></svg> Scan again';
});

const form = $('#addForm');
function syncPskField() { $('.psk', form).hidden = form.brand.value !== 'sony'; }
form.brand.addEventListener('change', syncPskField);

$('#detectBtn').addEventListener('click', async () => {
  const ip = form.ip.value.trim();
  if (!ip) return toast('Enter an IP address first', true);
  const btn = $('#detectBtn'); btn.disabled = true; btn.textContent = '…';
  try {
    const r = await api('probe', { ip });
    if (!r.brand) toast('Could not identify that TV. Pick the type yourself.', true);
    else {
      form.brand.value = r.brand; syncPskField();
      if (r.name && !form.name.value) form.name.value = r.name;
      toast(`Looks like: ${state.brands.find((b) => b.id === r.brand)?.label}`);
    }
  } catch (e) { toast(e.message, true); }
  btn.disabled = false; btn.textContent = 'Detect';
});

form.addEventListener('submit', (e) => {
  e.preventDefault();
  addTv({ ip: form.ip.value.trim(), brand: form.brand.value, name: form.name.value.trim(), psk: form.psk.value.trim() });
});

async function addTv(info) {
  try {
    const tv = await api('tvs', info);
    await loadTvs();
    selectTv(tv.id);
    form.reset(); syncPskField();
    startPair(currentTv());
  } catch (e) { toast(e.message, true); }
}

// ---------- pairing ----------
function pairUi({ title, msg, spin = false, code = false, psk = false, retry = false }) {
  $('#pairTitle').textContent = title;
  $('#pairMsg').innerHTML = msg;
  $('#pairSpin').hidden = !spin;
  $('#codeForm').hidden = !code;
  $('#pskForm').hidden = !psk;
  $('#pairRetry').hidden = !retry;
}

async function startPair(tv, extra = {}) {
  openSheet('sheetPair');
  pairUi({ title: `Connecting to ${tv.name}`, msg: PAIR_HINT[tv.brand] || 'Connecting…', spin: true });
  try {
    const r = await api(`tvs/${tv.id}/pair`, extra);
    if (r.status === 'needs_code') {
      const digits = r.codeLength === 4;
      pairUi({ title: 'Enter the code', msg: esc(r.message || 'Type the code shown on your TV screen.'), code: true });
      Object.assign($('#codeInput'), { value: '', maxLength: r.codeLength || 6, placeholder: digits ? '0000' : 'A1B2C3', inputMode: digits ? 'numeric' : 'text' });
      setTimeout(() => $('#codeInput').focus(), 50);
      return;
    }
    await done();
  } catch (e) {
    if (tv.brand === 'sony' && /key/i.test(e.message)) return pairUi({ title: tv.name, msg: esc(e.message), psk: true });
    pairUi({ title: 'Could not connect', msg: esc(e.message), retry: true });
  }
}

async function done() {
  await loadTvs();
  pairUi({ title: 'Connected', msg: '✓ Your remote is ready.' });
  buzz(30);
  setTimeout(closeSheets, 900);
}

$('#codeForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const tv = currentTv();
  pairUi({ title: 'Pairing…', msg: 'Checking the code…', spin: true });
  try {
    await api(`tvs/${tv.id}/pair-code`, { code: $('#codeInput').value });
    await done();
  } catch (err) {
    pairUi({ title: 'Enter the code', msg: `<span style="color:var(--danger)">${esc(err.message)}</span>`, code: true });
    $('#codeInput').value = '';
  }
});
$('#pskForm').addEventListener('submit', (e) => { e.preventDefault(); startPair(currentTv(), { psk: $('#pskInput').value.trim() }); });
$('#pairRetry').addEventListener('click', () => startPair(currentTv()));

// ---------- infrared setup ----------
const irForm = $('#irForm');
irForm.preset.innerHTML = Object.entries(IR.PRESETS).map(([id, p]) => `<option value="${id}">${esc(p.label)}</option>`).join('')
  + '<option value="custom">Other (paste your own codes)</option>';

irForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const preset = irForm.preset.value;
  const label = IR.PRESETS[preset]?.label || 'IR';
  const tv = { id: `ir${Date.now().toString(36)}`, name: irForm.name.value.trim() || `${label} TV (IR)`, preset, overrides: {} };
  state.irTvs.push(tv); saveIr();
  await loadTvs();
  selectTv(tv.id);
  irForm.reset();
  if (preset === 'custom') openIrCodes(tv.id);
  else { closeSheets(); toast('IR TV added. Volume to max and point the LEDs at the TV.'); }
});

// Power-code search: step through every brand's power signal until the TV reacts.
let searchIdx = 0;
function showSearch() {
  const id = IR.POWER_SEARCH[searchIdx];
  $('#irSearchStep').textContent = `Code ${searchIdx + 1} of ${IR.POWER_SEARCH.length}`;
  $('#irSearchName').textContent = IR.PRESETS[id].label;
}
async function sendSearch() {
  buzz();
  try { await IR.transmit(IR.signalFor(IR.POWER_SEARCH[searchIdx], 'power')); }
  catch (e) { toast(`Audio output failed: ${e.message}`, true); }
}
$('#irSearchBtn').addEventListener('click', () => { searchIdx = 0; openSheet('sheetIrSearch'); showSearch(); sendSearch(); });
$('#irSearchSend').addEventListener('click', sendSearch);
$('#irSearchNext').addEventListener('click', () => {
  searchIdx = (searchIdx + 1) % IR.POWER_SEARCH.length;
  if (searchIdx === 0) toast('Tried them all. Starting over. Not found? Pick “Other” and paste codes.', true);
  showSearch(); sendSearch();
});
$('#irSearchOk').addEventListener('click', () => {
  openSheet('sheetTvs');
  $('#irSection').open = true;
  irForm.preset.value = IR.POWER_SEARCH[searchIdx];
  irForm.name.focus();
  toast(`Found it: ${IR.PRESETS[IR.POWER_SEARCH[searchIdx]].label}`);
});

// Custom Pronto codes per button ("key = code" lines).
let editingIr = null;
function openIrCodes(id) {
  editingIr = state.irTvs.find((t) => t.id === id);
  if (!editingIr) return;
  $('#irCodes').value = Object.entries(editingIr.overrides || {}).map(([k, v]) => `${k} = ${v}`).join('\n');
  openSheet('sheetIrCodes');
}
$('#irCodesForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const overrides = {}, bad = [];
  for (const line of $('#irCodes').value.split('\n')) {
    if (!line.trim()) continue;
    const m = line.match(/^\s*([a-z_0-9]+)\s*[=:]\s*(.+)$/i);
    if (!m) { bad.push(line.trim().slice(0, 20)); continue; }
    try { IR.parsePronto(m[2]); overrides[m[1].toLowerCase()] = m[2].trim(); }
    catch { bad.push(m[1]); }
  }
  if (bad.length) return toast(`Could not read: ${bad.join(', ')}`, true);
  editingIr.overrides = overrides; saveIr();
  await loadTvs();
  closeSheets();
  toast(`Saved ${Object.keys(overrides).length} custom code(s)`);
});

// ---------- text ----------
$('#textForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const tv = currentTv(), input = $('#textInput');
  if (!tv || !input.value) return;
  if (tv.ir) return toast('Typing needs a Wi-Fi TV. Use the number pad or arrows instead.', true);
  try { await api(`tvs/${tv.id}/text`, { text: input.value }); toast('Sent'); input.value = ''; }
  catch (err) { toast(err.message, true); }
});

// ---------- boot ----------
(async function init() {
  bindKeys();
  setMode(store.get('mode', 'buttons'));
  try {
    const info = await api('info');
    state.brands = info.brands;
    $('#appUrl').textContent = info.url;
    form.brand.innerHTML = info.brands.map((b) => `<option value="${b.id}">${esc(b.label)}</option>`).join('');
    syncPskField();
  } catch {
    toast('Wi-Fi TV service is not running. Infrared TVs still work.', true);
  }
  await loadTvs();
  if (!state.tvs.length && (matchMedia('(pointer: coarse)').matches || innerWidth < 600)) openSheet('sheetTvs');
})();
