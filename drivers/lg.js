// LG webOS TVs: SSAP over WebSocket (wss:3001 on current firmware, ws:3000 on older).
// First connection shows an "accept" prompt on the TV; the client-key it returns is saved.
// Buttons go through a secondary "pointer input" socket.
import WebSocket from 'ws';
import { readFileSync } from 'node:fs';
import { withTimeout } from '../lib/util.js';

const MANIFEST = JSON.parse(readFileSync(new URL('./lg-manifest.json', import.meta.url), 'utf8'));

const BUTTONS = {
  up: 'UP', down: 'DOWN', left: 'LEFT', right: 'RIGHT', ok: 'ENTER',
  back: 'BACK', home: 'HOME', menu: 'MENU', settings: 'MENU', info: 'INFO', guide: 'GUIDE', exit: 'EXIT',
  vol_up: 'VOLUMEUP', vol_down: 'VOLUMEDOWN', mute: 'MUTE', ch_up: 'CHANNELUP', ch_down: 'CHANNELDOWN',
  play: 'PLAY', pause: 'PAUSE', stop: 'STOP', rewind: 'REWIND', ffwd: 'FASTFORWARD',
  red: 'RED', green: 'GREEN', yellow: 'YELLOW', blue: 'BLUE',
};
for (let i = 0; i <= 9; i++) BUTTONS[`num_${i}`] = String(i);

const APPS = { netflix: 'netflix', youtube: 'youtube.leanback.v4', prime: 'amazon', disney: 'com.disney.disneyplus-prod' };

export default class LgDriver {
  static brand = 'lg';
  static label = 'LG webOS';

  constructor(tv, save) {
    this.tv = tv; this.save = save;
    this.ws = null; this.pointer = null; this.connecting = null;
    this.pending = new Map(); this.nextId = 1; this.playing = false;
  }

  /** Open the main socket and register (shows the TV prompt the first time). */
  open(url, waitMs) {
    return new Promise((resolve, reject) => {
      // TVs only serve self-signed certificates, so verification is off for this LAN-only socket.
      const ws = new WebSocket(url, { rejectUnauthorized: false, handshakeTimeout: 4000 });
      const timer = setTimeout(() => { ws.terminate(); reject(new Error('No answer from the TV. If a prompt is showing on the TV, accept it and try again.')); }, waitMs);
      ws.on('open', () => {
        const payload = { ...MANIFEST };
        if (this.tv.clientKey) payload['client-key'] = this.tv.clientKey;
        ws.send(JSON.stringify({ type: 'register', id: 'register_0', payload }));
      });
      ws.on('message', (raw) => {
        let msg; try { msg = JSON.parse(raw); } catch { return; }
        if (msg.id === 'register_0') {
          if (msg.type === 'registered') {
            clearTimeout(timer);
            const key = msg.payload?.['client-key'];
            if (key && key !== this.tv.clientKey) { this.tv.clientKey = key; this.save(); }
            resolve(ws);
          } else if (msg.type === 'error') {
            clearTimeout(timer); ws.terminate();
            reject(new Error(`The TV refused pairing: ${msg.error || 'rejected'}`));
          }
          return;
        }
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          if (msg.type === 'error' || msg.payload?.returnValue === false) p.reject(new Error(msg.error || msg.payload?.errorText || 'TV error'));
          else p.resolve(msg.payload);
        }
      });
      ws.on('error', (e) => { clearTimeout(timer); reject(e); });
      ws.on('close', () => { if (this.ws === ws) { this.ws = null; this.pointer?.terminate(); this.pointer = null; } });
    });
  }

  async connect(waitMs = 6000) {
    if (this.ws?.readyState === WebSocket.OPEN) return this.ws;
    if (!this.connecting) {
      this.connecting = (async () => {
        try { return await this.open(`wss://${this.tv.ip}:3001`, waitMs); }
        catch (e) {
          if (/refused pairing|prompt/.test(e.message)) throw e;
          return await this.open(`ws://${this.tv.ip}:3000`, waitMs).catch(() => { throw e; });
        }
      })().then((ws) => (this.ws = ws)).finally(() => { this.connecting = null; });
    }
    return this.connecting;
  }

  async request(uri, payload = {}) {
    const ws = await this.connect();
    const id = `req_${this.nextId++}`;
    const result = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    ws.send(JSON.stringify({ type: 'request', id, uri, payload }));
    return withTimeout(result, 5000, 'The TV did not respond').finally(() => this.pending.delete(id));
  }

  async getPointer() {
    if (this.pointer?.readyState === WebSocket.OPEN) return this.pointer;
    const { socketPath } = await this.request('ssap://com.webos.service.networkinput/getPointerInputSocket');
    this.pointer = await new Promise((resolve, reject) => {
      const ws = new WebSocket(socketPath, { rejectUnauthorized: false, handshakeTimeout: 4000 });
      ws.once('open', () => resolve(ws));
      ws.once('error', reject);
    });
    return this.pointer;
  }

  async pair() {
    await this.connect(30000); // time to accept the prompt on the TV
    try {
      const info = await this.request('ssap://com.webos.service.connectionmanager/getinfo');
      this.tv.mac ||= info?.wiredInfo?.macAddress || info?.wifiInfo?.macAddress;
    } catch {}
    return { status: 'paired' };
  }

  async key(k) {
    if (k === 'power' || k === 'power_off') return void (await this.request('ssap://system/turnOff'));
    if (k === 'play_pause') { this.playing = !this.playing; k = this.playing ? 'play' : 'pause'; }
    if (k === 'input') return void (await this.request('ssap://system.launcher/launch', { id: 'com.webos.app.inputpicker' }));
    if (k === 'backspace') return void (await this.request('ssap://com.webos.service.ime/deleteCharacters', { count: 1 }));
    if (k === 'enter') return void (await this.request('ssap://com.webos.service.ime/sendEnterKey'));
    const name = BUTTONS[k];
    if (!name) throw new Error(`"${k}" is not supported on LG`);
    (await this.getPointer()).send(`type:button\nname:${name}\n\n`);
  }

  async text(str) { await this.request('ssap://com.webos.service.ime/insertText', { text: str, replace: 0 }); }

  async app(name) {
    if (!APPS[name]) throw new Error('App not available');
    await this.request('ssap://system.launcher/launch', { id: APPS[name] });
  }

  close() { this.pointer?.terminate(); this.ws?.terminate(); this.ws = this.pointer = null; }
}
