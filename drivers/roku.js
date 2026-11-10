// Roku TVs and sticks: External Control Protocol (plain HTTP on port 8060, no pairing).
// Newer Roku OS: Settings > System > Advanced system settings > Control by mobile apps > Network access = Default/Permissive.
import { fetchT, xmlTag } from '../lib/util.js';

const KEYS = {
  power: 'Power', power_off: 'PowerOff', power_on: 'PowerOn',
  up: 'Up', down: 'Down', left: 'Left', right: 'Right', ok: 'Select',
  back: 'Back', home: 'Home', info: 'Info', menu: 'Info', search: 'Search',
  vol_up: 'VolumeUp', vol_down: 'VolumeDown', mute: 'VolumeMute',
  ch_up: 'ChannelUp', ch_down: 'ChannelDown', input: 'InputTuner',
  play_pause: 'Play', play: 'Play', pause: 'Play', rewind: 'Rev', ffwd: 'Fwd', prev: 'InstantReplay',
  backspace: 'Backspace', enter: 'Enter',
};
for (let i = 0; i <= 9; i++) KEYS[`num_${i}`] = `Lit_${i}`;

const APPS = { netflix: '12', youtube: '837', prime: '13', disney: '291097' };

export default class RokuDriver {
  static brand = 'roku';
  static label = 'Roku';

  constructor(tv) { this.tv = tv; this.base = `http://${tv.ip}:8060`; }

  async post(path) {
    const res = await fetchT(this.base + path, { method: 'POST' });
    if (res.status === 403) throw new Error('Roku refused control. On the TV: Settings > System > Advanced system settings > Control by mobile apps > Network access: Default');
    if (!res.ok) throw new Error(`Roku answered HTTP ${res.status}`);
  }

  async pair() {
    const res = await fetchT(`${this.base}/query/device-info`);
    if (!res.ok) throw new Error(`Roku answered HTTP ${res.status}`);
    const xml = await res.text();
    this.tv.mac ||= xmlTag(xml, 'wifi-mac') || xmlTag(xml, 'ethernet-mac');
    return { status: 'paired' };
  }

  async key(k) {
    const code = KEYS[k];
    if (!code) throw new Error(`"${k}" is not supported on Roku`);
    await this.post(`/keypress/${code}`);
  }

  async text(str) {
    for (const ch of str) await this.post(`/keypress/Lit_${encodeURIComponent(ch)}`);
  }

  async app(name) {
    if (!APPS[name]) throw new Error('App not available');
    await this.post(`/launch/${APPS[name]}`);
  }

  close() {}
}
