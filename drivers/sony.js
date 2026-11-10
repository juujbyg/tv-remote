// Sony Bravia over IP (IRCC buttons + JSON-RPC).
// - 2013-2014 models: buttons work as-is; registering with the 4-digit PIN the TV shows unlocks
//   typing and power control (auth cookie).
// - 2015+ models: set Settings > Network > IP control > Authentication = "Normal and Pre-Shared Key"
//   and enter the key here (Google/Android Sony TVs can use the Android TV driver instead).
import { randomUUID } from 'node:crypto';
import { fetchT } from '../lib/util.js';

// Our key -> candidate Sony IRCC command names (the TV reports which ones it supports).
const KEYS = {
  power_off: ['PowerOff'], up: ['Up'], down: ['Down'], left: ['Left'], right: ['Right'], ok: ['Confirm'],
  back: ['Return', 'Back'], home: ['Home'], menu: ['Options', 'ActionMenu'], settings: ['ActionMenu', 'Options', 'Home'],
  info: ['Display'], guide: ['GGuide', 'EPG'], input: ['Input'], exit: ['Exit'],
  vol_up: ['VolumeUp'], vol_down: ['VolumeDown'], mute: ['Mute'], ch_up: ['ChannelUp'], ch_down: ['ChannelDown'],
  play: ['Play'], pause: ['Pause'], stop: ['Stop'], rewind: ['Rewind'], ffwd: ['Forward'], prev: ['Prev'], next: ['Next'],
  red: ['Red'], green: ['Green'], yellow: ['Yellow'], blue: ['Blue'], search: ['SEN', 'Search'],
};
for (let i = 0; i <= 9; i++) KEYS[`num_${i}`] = [`Num${i}`];

const authNeeded = (json) => json && 'auth_url' in json;

export default class SonyDriver {
  static brand = 'sony';
  static label = 'Sony Bravia';

  constructor(tv, save) { this.tv = tv; this.save = save; this.playing = false; }

  headers(extra = {}) {
    const h = { ...extra };
    if (this.tv.psk) h['X-Auth-PSK'] = this.tv.psk;
    if (this.tv.cookie) h.Cookie = this.tv.cookie;
    return h;
  }

  async rpc(service, method, params = [], version = '1.0', retried = false) {
    const res = await fetchT(`http://${this.tv.ip}/sony/${service}`, {
      method: 'POST', headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ method, params, id: 1, version }),
    });
    const json = await res.json().catch(() => ({}));
    if (authNeeded(json) || res.status === 401 || res.status === 403 || json.error?.[0] === 403) {
      if (!retried && this.tv.cookie && await this.renew()) return this.rpc(service, method, params, version, true);
      throw Object.assign(new Error(this.tv.psk ? 'Wrong Pre-Shared Key' : 'This needs the TV to be registered: open “Your TVs” and tap Connect to enter the PIN'), { auth: true });
    }
    if (json.error) throw new Error(`TV error: ${json.error[1] || json.error[0]}`);
    return json.result;
  }

  /** actRegister: without a PIN the TV shows one; with it, the TV hands back an auth cookie. */
  async register(pin) {
    this.tv.clientId ||= `PhoneRemote:${randomUUID()}`;
    const headers = { 'Content-Type': 'application/json' };
    if (pin) headers.Authorization = `Basic ${Buffer.from(`:${pin}`).toString('base64')}`;
    else if (this.tv.cookie) headers.Cookie = this.tv.cookie;
    const res = await fetchT(`http://${this.tv.ip}/sony/accessControl`, {
      method: 'POST', headers,
      body: JSON.stringify({ method: 'actRegister', id: 8, version: '1.0', params: [
        { clientid: this.tv.clientId, nickname: 'Phone Remote', level: 'private' },
        [{ value: 'yes', function: 'WOL' }],
      ] }),
    }, 5000);
    const cookie = res.headers.get('set-cookie')?.match(/auth=[^;]+/)?.[0];
    if (res.ok && cookie) { this.tv.cookie = cookie; this.save(); }
    return res;
  }

  async renew() {
    const res = await this.register().catch(() => null);
    return !!res?.ok;
  }

  async pair() {
    const result = await this.rpc('system', 'getRemoteControllerInfo').catch((e) => { if (e.auth) return null; throw e; });
    if (result) this.tv.codes = Object.fromEntries((result?.[1] || []).map((c) => [c.name, c.value]));
    if (this.tv.psk) {
      await this.rpc('system', 'getPowerStatus'); // validates the key
      this.save();
      return { status: 'paired' };
    }
    this.save();
    // Older Bravias: ask the TV for a PIN so typing and power control work too.
    const res = await this.register().catch(() => null);
    if (res?.status === 401) return { status: 'needs_code', codeLength: 4, message: 'Type the 4-digit PIN shown on your TV' };
    if (!this.tv.codes) throw new Error('Enter the Pre-Shared Key you set on the TV (Settings → Network → IP control)');
    return { status: 'paired' };
  }

  async pairCode(pin) {
    const res = await this.register(String(pin).trim());
    if (!res.ok) throw Object.assign(new Error('Wrong PIN. A new one is coming up on the TV.'), { retryPair: true });
    return { status: 'paired' };
  }

  async ircc(code) {
    const body = `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:X_SendIRCC xmlns:u="urn:schemas-sony-com:service:IRCC:1"><IRCCCode>${code}</IRCCCode></u:X_SendIRCC></s:Body></s:Envelope>`;
    const res = await fetchT(`http://${this.tv.ip}/sony/IRCC`, {
      method: 'POST', body,
      headers: this.headers({ 'Content-Type': 'text/xml; charset=UTF-8', SOAPACTION: '"urn:schemas-sony-com:service:IRCC:1#X_SendIRCC"' }),
    });
    if (res.status === 403 || res.status === 401) throw new Error(this.tv.psk ? 'Wrong Pre-Shared Key' : 'The TV wants a Pre-Shared Key (Settings → Network → IP control)');
    if (!res.ok) throw new Error(`TV answered HTTP ${res.status}`);
  }

  async sendNamed(names) {
    if (!this.tv.codes) {
      const result = await this.rpc('system', 'getRemoteControllerInfo');
      this.tv.codes = Object.fromEntries((result?.[1] || []).map((c) => [c.name, c.value]));
      this.save();
    }
    const name = names.find((n) => this.tv.codes[n]);
    if (!name) return false;
    await this.ircc(this.tv.codes[name]);
    return true;
  }

  async key(k) {
    if (k === 'power') {
      const status = await this.rpc('system', 'getPowerStatus').catch(() => null);
      if (status?.[0]?.status === 'active') return void (await this.sendNamed(['PowerOff', 'TvPower', 'Power']));
      return void (await this.rpc('system', 'setPowerStatus', [{ status: true }]));
    }
    if (k === 'play_pause') { this.playing = !this.playing; k = this.playing ? 'play' : 'pause'; }
    if (!KEYS[k] || !(await this.sendNamed(KEYS[k]))) throw new Error(`"${k}" is not supported on this Sony TV`);
  }

  async text(str) { await this.rpc('appControl', 'setTextForm', [str]); }

  async app(name) {
    const names = { netflix: ['Netflix'], youtube: ['YouTube'] }[name];
    if (names && (await this.sendNamed(names))) return;
    throw new Error('This app has no shortcut on this Sony TV');
  }

  close() {}
}
