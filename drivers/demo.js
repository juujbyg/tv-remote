// A virtual TV shown in a browser at /tv.html. Handy for trying the remote without a real TV.
import { EventEmitter } from 'node:events';

export const demoBus = new EventEmitter();
demoBus.setMaxListeners(50);

export default class DemoDriver {
  static brand = 'demo';
  static label = 'Test TV (browser window)';

  constructor(tv) { this.tv = tv; }
  emit(type, value) { demoBus.emit('event', { tv: this.tv.id, type, value, at: Date.now() }); }
  async pair() { return { status: 'paired' }; }
  async key(k) { this.emit('key', k); }
  async text(str) { this.emit('text', str); }
  async app(name) { this.emit('app', name); }
  close() {}
}
