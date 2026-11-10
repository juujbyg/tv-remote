// Android TV / Google TV (Sony, TCL, Hisense, Philips, Xiaomi, Chromecast with Google TV, Shield...):
// "Android TV Remote v2" protocol. Pairing shows a 6-character code on the TV that you type in the app.
import { AndroidRemote, RemoteKeyCode, RemoteDirection } from 'androidtv-remote';
import { withTimeout } from '../lib/util.js';

const KEYS = {
  power: 'KEYCODE_POWER', power_off: 'KEYCODE_POWER',
  up: 'KEYCODE_DPAD_UP', down: 'KEYCODE_DPAD_DOWN', left: 'KEYCODE_DPAD_LEFT', right: 'KEYCODE_DPAD_RIGHT',
  ok: 'KEYCODE_DPAD_CENTER', back: 'KEYCODE_BACK', home: 'KEYCODE_HOME', menu: 'KEYCODE_MENU',
  info: 'KEYCODE_INFO', guide: 'KEYCODE_GUIDE', input: 'KEYCODE_TV_INPUT', settings: 'KEYCODE_SETTINGS',
  vol_up: 'KEYCODE_VOLUME_UP', vol_down: 'KEYCODE_VOLUME_DOWN', mute: 'KEYCODE_VOLUME_MUTE',
  ch_up: 'KEYCODE_CHANNEL_UP', ch_down: 'KEYCODE_CHANNEL_DOWN',
  play_pause: 'KEYCODE_MEDIA_PLAY_PAUSE', play: 'KEYCODE_MEDIA_PLAY', pause: 'KEYCODE_MEDIA_PAUSE',
  stop: 'KEYCODE_MEDIA_STOP', rewind: 'KEYCODE_MEDIA_REWIND', ffwd: 'KEYCODE_MEDIA_FAST_FORWARD',
  prev: 'KEYCODE_MEDIA_PREVIOUS', next: 'KEYCODE_MEDIA_NEXT',
  red: 'KEYCODE_PROG_RED', green: 'KEYCODE_PROG_GREEN', yellow: 'KEYCODE_PROG_YELLOW', blue: 'KEYCODE_PROG_BLUE',
  search: 'KEYCODE_SEARCH', backspace: 'KEYCODE_DEL', enter: 'KEYCODE_ENTER',
};
for (let i = 0; i <= 9; i++) KEYS[`num_${i}`] = `KEYCODE_${i}`;

const CHARS = { ' ': 'KEYCODE_SPACE', '.': 'KEYCODE_PERIOD', ',': 'KEYCODE_COMMA', '@': 'KEYCODE_AT', '-': 'KEYCODE_MINUS', '\n': 'KEYCODE_ENTER' };

const APPS = {
  netflix: 'https://www.netflix.com/title', youtube: 'https://www.youtube.com',
  prime: 'https://app.primevideo.com', disney: 'https://www.disneyplus.com',
};

export default class AndroidTvDriver {
  static brand = 'androidtv';
  static label = 'Android TV / Google TV';

  constructor(tv, save) { this.tv = tv; this.save = save; this.remote = null; this.ready = null; this.pairing = null; }

  wire(remote) {
    // The library emits these without its own listeners; an unhandled 'error' would crash the server.
    remote.on('error', (e) => console.warn(`[androidtv ${this.tv.ip}]`, e?.error || e));
    remote.on('unpaired', () => {
      console.warn(`[androidtv ${this.tv.ip}] TV forgot this remote; pair again.`);
      delete this.tv.cert; this.save(); this.close();
    });
    remote.on('volume', (v) => (this.volume = v));
    const patchManager = () => remote.remoteManager?.listenerCount('error') || remote.remoteManager?.on('error', () => {});
    remote.on('ready', patchManager);
  }

  connect() {
    if (this.remote && this.ready) return this.ready;
    if (!this.tv.cert) return Promise.reject(Object.assign(new Error('Not paired yet'), { needsPair: true }));
    const remote = new AndroidRemote(this.tv.ip, { cert: this.tv.cert, service_name: 'Phone Remote' });
    this.wire(remote);
    this.remote = remote;
    this.ready = withTimeout(new Promise((resolve, reject) => {
      remote.once('ready', resolve);
      remote.start().then((ok) => { if (!ok) reject(new Error('Could not connect to the TV (is it on?)')); }, reject);
    }), 8000, 'The TV did not answer (is it on and on the same network?)')
      .catch((e) => { this.close(); throw e; });
    return this.ready;
  }

  /** Step 1: open the pairing channel. The TV shows a code. */
  async pair() {
    this.close();
    delete this.tv.cert;
    const remote = new AndroidRemote(this.tv.ip, { service_name: 'Phone Remote' });
    this.wire(remote);
    this.remote = remote;
    const secret = new Promise((resolve) => remote.once('secret', resolve));
    this.pairing = remote.start(); // resolves once the code has been accepted and the remote channel is up
    this.pairing.catch(() => {});
    const first = await withTimeout(Promise.race([secret.then(() => 'code'), this.pairing.then(() => 'ended')]), 10000,
      'The TV did not answer on port 6467. Is it an Android/Google TV, switched on?');
    if (first !== 'code') throw new Error('Pairing was refused by the TV');
    return { status: 'needs_code', message: 'Type the code shown on your TV' };
  }

  /** Step 2: send the code from the TV screen. */
  async pairCode(code) {
    if (!this.remote?.pairingManager) throw new Error('Start pairing first');
    const ok = this.remote.sendCode(String(code).trim().toUpperCase());
    if (!ok) throw Object.assign(new Error('Wrong code. A new code is coming up on the TV.'), { retryPair: true });
    const ready = new Promise((resolve) => this.remote.once('ready', resolve));
    await withTimeout(Promise.all([this.pairing, ready]), 10000, 'TV accepted the code but did not connect');
    this.tv.cert = this.remote.getCertificate();
    this.save();
    this.ready = Promise.resolve();
    return { status: 'paired' };
  }

  async send(keyName) {
    await this.connect();
    this.remote.sendKey(RemoteKeyCode[keyName], RemoteDirection.SHORT);
  }

  async key(k) {
    if (!KEYS[k]) throw new Error(`"${k}" is not supported on Android TV`);
    await this.send(KEYS[k]);
  }

  async text(str) {
    for (const ch of str.toLowerCase()) {
      const name = CHARS[ch] || (/[a-z0-9]/.test(ch) ? `KEYCODE_${ch.toUpperCase()}` : null);
      if (name && RemoteKeyCode[name] !== undefined) await this.send(name);
    }
  }

  async app(name) {
    if (!APPS[name]) throw new Error('App not available');
    await this.connect();
    this.remote.sendAppLink(APPS[name]);
  }

  close() {
    const r = this.remote;
    this.remote = null; this.ready = null;
    if (!r) return;
    r.removeAllListeners();
    r.on('error', () => {});
    // Drop the library's auto-reconnect handler before closing the sockets.
    for (const sock of [r.remoteManager?.client, r.pairingManager?.client]) {
      if (!sock) continue;
      sock.removeAllListeners('close');
      sock.on('error', () => {});
      sock.destroy();
    }
    r.remoteManager?.on('error', () => {});
  }
}
