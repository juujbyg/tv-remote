// Samsung Tizen TVs (2016+): WebSocket remote API. Secure port 8002 issues a token after
// you press "Allow" on the TV; older models use the unauthenticated port 8001.
import WebSocket from 'ws';
import { fetchT } from '../lib/util.js';

// TVs only serve self-signed certificates, so verification is off for this LAN-only socket.

const APP_NAME = Buffer.from('Phone Remote').toString('base64');

const KEYS = {
  power: 'KEY_POWER', power_off: 'KEY_POWER',
  up: 'KEY_UP', down: 'KEY_DOWN', left: 'KEY_LEFT', right: 'KEY_RIGHT', ok: 'KEY_ENTER',
  back: 'KEY_RETURN', home: 'KEY_HOME', menu: 'KEY_MENU', info: 'KEY_INFO', guide: 'KEY_GUIDE',
  input: 'KEY_SOURCE', settings: 'KEY_MENU', exit: 'KEY_EXIT',
  vol_up: 'KEY_VOLUP', vol_down: 'KEY_VOLDOWN', mute: 'KEY_MUTE',
  ch_up: 'KEY_CHUP', ch_down: 'KEY_CHDOWN',
  play_pause: 'KEY_PLAY', play: 'KEY_PLAY', pause: 'KEY_PAUSE', stop: 'KEY_STOP',
  rewind: 'KEY_REWIND', ffwd: 'KEY_FF',
  red: 'KEY_RED', green: 'KEY_GREEN', yellow: 'KEY_YELLOW', blue: 'KEY_CYAN',
  enter: 'KEY_ENTER',
};
for (let i = 0; i <= 9; i++) KEYS[`num_${i}`] = `KEY_${i}`;

const APPS = { netflix: '3201907018807', youtube: '111299001912', prime: '3201910019365', disney: '3201901017640' };

export default class SamsungDriver {
  static brand = 'samsung';
  static label = 'Samsung';

  constructor(tv, save) { this.tv = tv; this.save = save; this.ws = null; this.connecting = null; }

  url(secure) {
    const token = this.tv.token ? `&token=${this.tv.token}` : '';
    return secure
      ? `wss://${this.tv.ip}:8002/api/v2/channels/samsung.remote.control?name=${APP_NAME}${token}`
      : `ws://${this.tv.ip}:8001/api/v2/channels/samsung.remote.control?name=${APP_NAME}`;
  }

  open(secure, waitMs) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url(secure), { rejectUnauthorized: false, handshakeTimeout: 4000 });
      const timer = setTimeout(() => { ws.terminate(); reject(new Error('No answer from the TV. If a prompt is showing on the TV, choose Allow and try again.')); }, waitMs);
      ws.on('message', (raw) => {
        let msg; try { msg = JSON.parse(raw); } catch { return; }
        if (msg.event === 'ms.channel.connect') {
          clearTimeout(timer);
          if (msg.data?.token && msg.data.token !== this.tv.token) { this.tv.token = msg.data.token; this.save(); }
          resolve(ws);
        } else if (msg.event === 'ms.channel.unauthorized') {
          clearTimeout(timer); ws.terminate();
          reject(new Error('The TV denied access. On the TV: Settings > General > External Device Manager > Device Connection Manager, allow "Phone Remote".'));
        }
      });
      ws.on('error', (e) => { clearTimeout(timer); reject(e); });
      ws.on('close', () => { if (this.ws === ws) this.ws = null; });
    });
  }

  async connect(waitMs = 6000) {
    if (this.ws?.readyState === WebSocket.OPEN) return this.ws;
    if (!this.connecting) {
      this.connecting = (async () => {
        try { return await this.open(true, waitMs); }
        catch (e) {
          if (/denied|prompt/.test(e.message)) throw e;
          return await this.open(false, 4000).catch(() => { throw e; });
        }
      })().then((ws) => (this.ws = ws)).finally(() => { this.connecting = null; });
    }
    return this.connecting;
  }

  async pair() {
    try {
      const info = await (await fetchT(`http://${this.tv.ip}:8001/api/v2/`)).json();
      this.tv.mac ||= info?.device?.wifiMac;
      this.tv.model ||= info?.device?.modelName;
    } catch {}
    await this.connect(30000); // gives you 30 s to press "Allow" on the TV
    return { status: 'paired' };
  }

  async key(k) {
    const code = KEYS[k];
    if (!code) throw new Error(`"${k}" is not supported on Samsung`);
    const ws = await this.connect();
    ws.send(JSON.stringify({
      method: 'ms.remote.control',
      params: { Cmd: 'Click', DataOfCmd: code, Option: 'false', TypeOfRemote: 'SendRemoteKey' },
    }));
  }

  async text(str) {
    // Only works while an on-screen keyboard is open on the TV.
    const ws = await this.connect();
    ws.send(JSON.stringify({
      method: 'ms.remote.control',
      params: { Cmd: Buffer.from(str).toString('base64'), DataOfCmd: 'base64', TypeOfRemote: 'SendInputString' },
    }));
  }

  async app(name) {
    if (!APPS[name]) throw new Error('App not available');
    const res = await fetchT(`http://${this.tv.ip}:8001/api/v2/applications/${APPS[name]}`, { method: 'POST' });
    if (!res.ok) throw new Error(`Could not open the app (HTTP ${res.status}). Is it installed?`);
  }

  close() { this.ws?.terminate(); this.ws = null; }
}
