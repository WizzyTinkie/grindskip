import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { after, before, test } from 'node:test';

// Stand-ins for the page's Media Source Extensions and window, installed
// before the hook wraps them
class SourceBuffer {
  appended = [];
  aborted = 0;
  appendBuffer(data) { this.appended.push(data); }
  abort() { this.aborted++; }
}
class MediaSource {
  addSourceBuffer() { return new SourceBuffer(); }
}
let urls = 0;
const listeners = [];
const createObjectURL = URL.createObjectURL;

const HELLO = 'grindskip:lookahead';
const webmInit = () => Uint8Array.of(0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3);
const bytes = (n, fill = 7) => new Uint8Array(n).fill(fill);

let port;
let received;
before(async () => {
  globalThis.MediaSource = MediaSource;
  globalThis.SourceBuffer = SourceBuffer;
  globalThis.window = { addEventListener: (type, fn) => listeners.push(fn) };
  URL.createObjectURL = () => `blob:test/${urls++}`;
  await import('../src/page/hook.js');
  // The content script's hello, with its end of a channel
  const channel = new MessageChannel();
  port = channel.port2;
  received = [];
  port.on('message', (m) => received.push(m));
  for (const fn of listeners) fn({ source: globalThis.window, data: { type: HELLO }, ports: [channel.port1], stopImmediatePropagation() {} });
});
after(() => {
  port.close();
  URL.createObjectURL = createObjectURL;
  delete globalThis.window;
});

// Waits for the messages in flight, and returns and forgets them
async function take() {
  await sleep(10);
  return received.splice(0);
}
const follow = (url) => port.postMessage({ follow: url });

test('the page\'s own methods still do their work', () => {
  const ms = new MediaSource();
  assert.match(URL.createObjectURL(ms), /^blob:test\//);
  const sb = ms.addSourceBuffer('audio/webm; codecs="opus"');
  assert.ok(sb instanceof SourceBuffer);
  sb.appendBuffer(bytes(3));
  sb.abort();
  assert.equal(sb.appended.length, 1);
  assert.equal(sb.aborted, 1);
  // Whatever the page passes, the hook doesn't throw into it
  sb.appendBuffer(null);
  assert.equal(sb.appended.length, 2);
});

test('the followed video\'s audio comes through: what was kept, then new appends', async () => {
  await take();
  const ms = new MediaSource();
  const url = URL.createObjectURL(ms);
  const audio = ms.addSourceBuffer('audio/webm; codecs="opus"');
  const video = ms.addSourceBuffer('video/mp4; codecs="avc1.4D401E"');
  audio.appendBuffer(webmInit());
  audio.appendBuffer(bytes(10, 1));
  video.appendBuffer(bytes(10, 9));
  audio.appendBuffer(new Uint8Array(bytes(20, 2)).buffer);
  assert.deepEqual(await take(), [], 'nothing before the video is followed');

  follow(url);
  const kept = await take();
  assert.deepEqual(kept.map((m) => m.type), ['following', 'buffer', 'append', 'append', 'append']);
  assert.equal(kept[0].found, true);
  assert.equal(kept[1].mime, 'audio/webm; codecs="opus"');
  assert.deepEqual(kept.slice(2).map((m) => [m.init, m.bytes.length, m.bytes[0]]), [[true, 7, 0x1a], [false, 10, 1], [false, 20, 2]]);

  audio.appendBuffer(bytes(5, 3));
  video.appendBuffer(bytes(5, 9));
  audio.abort();
  const live = await take();
  assert.deepEqual(live.map((m) => m.type), ['append', 'gap']);
  assert.equal(live[0].bytes[0], 3);

  // Another page's video: nothing from it
  const other = new MediaSource();
  URL.createObjectURL(other);
  other.addSourceBuffer('audio/webm; codecs="opus"').appendBuffer(bytes(5, 4));
  assert.deepEqual(await take(), []);
});

test('an unknown URL is reported, and nothing comes through', async () => {
  await take();
  follow('blob:test/nope');
  const m = await take();
  assert.deepEqual(m.map((x) => [x.type, x.found]), [['following', false]]);
});

test('beyond 4 MB the oldest appends go, marked by a gap, but not the init segment', async () => {
  await take();
  const ms = new MediaSource();
  const url = URL.createObjectURL(ms);
  const sb = ms.addSourceBuffer('audio/webm; codecs="opus"');
  sb.appendBuffer(webmInit());
  for (let i = 0; i < 4; i++) sb.appendBuffer(bytes(1.5 * 1024 * 1024, i));
  follow(url);
  const kept = await take();
  assert.deepEqual(kept.map((m) => m.type), ['following', 'buffer', 'append', 'gap', 'append', 'append']);
  assert.equal(kept[2].init, true);
  assert.deepEqual(kept.slice(4).map((m) => m.bytes[0]), [2, 3]);
});
