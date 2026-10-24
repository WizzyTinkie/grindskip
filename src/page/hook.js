// Runs in the page's own world before its scripts (a "MAIN" world content
// script at document_start): watches what video players hand to Media
// Source Extensions, and passes the audio of the video Grindskip follows on
// to its content script, which analyses it before it plays
// (lookahead/feed.js).
//
// It only reads: every wrapped method goes on to the browser's own, and
// nothing here may throw into the page. The page can see the wrappers and
// the messages; the worst it can do with them is mislead Grindskip on that
// page.
//
// The content script loads later (document_idle) and picks a video at any
// time, so for each audio SourceBuffer the hook keeps the latest init
// segment and the recent appends (up to KEEP_BYTES), and hands them over
// when that video is followed, then forwards new appends as they come.
//
// Protocol: the content script posts { type: HELLO } to the window with a
// MessagePort. On that port it sends { follow: url } (the followed video's
// currentSrc, or null for none) and receives
//   { type: 'following', url, found }        whether url is a MediaSource's
//   { type: 'buffer', buffer, mime }         an audio SourceBuffer of it
//   { type: 'append', buffer, bytes, init }  bytes appended to one (init:
//                                            an init segment)
//   { type: 'gap', buffer }                  appends were missed or aborted:
//                                            the next one starts afresh
(() => {
  const HELLO = 'grindskip:lookahead';
  // About four minutes of YouTube's Opus per buffer
  const KEEP_BYTES = 4 * 1024 * 1024;
  const KEEP_SOURCES = 8;

  const sourceIds = new WeakMap();  // MediaSource -> id
  const byUrl = new Map();          // blob URL -> source id, oldest first
  const sources = new Map();        // source id -> its audio buffers' states, oldest first
  const buffers = new WeakMap();    // SourceBuffer -> its state
  let nextId = 0;
  let port = null;
  let following = null;             // the followed source id

  const send = (msg) => {
    try {
      port?.postMessage(msg);
    } catch {
      // The content script went away (the extension was reloaded)
      port = null;
    }
  };
  const sourceId = (ms) => {
    if (!sourceIds.has(ms)) {
      sourceIds.set(ms, nextId++);
      sources.set(sourceIds.get(ms), []);
      if (sources.size > KEEP_SOURCES) sources.delete(sources.keys().next().value);
    }
    return sourceIds.get(ms);
  };
  const isInit = (b) => (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3)  // WebM
    || (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70);                  // MP4 ftyp

  const createObjectURL = URL.createObjectURL;
  URL.createObjectURL = function (obj) {
    const url = createObjectURL.apply(this, arguments);
    try {
      if (obj instanceof MediaSource) {
        byUrl.set(url, sourceId(obj));
        if (byUrl.size > KEEP_SOURCES) byUrl.delete(byUrl.keys().next().value);
      }
    } catch { /* never into the page */ }
    return url;
  };

  const addSourceBuffer = MediaSource.prototype.addSourceBuffer;
  MediaSource.prototype.addSourceBuffer = function (mime) {
    const sb = addSourceBuffer.apply(this, arguments);
    try {
      if (/^\s*audio\//i.test(String(mime))) {
        const b = { buffer: nextId++, source: sourceId(this), mime: String(mime), init: null, appends: [], bytes: 0, cut: false };
        buffers.set(sb, b);
        sources.get(b.source)?.push(b);
        if (b.source === following) send({ type: 'buffer', buffer: b.buffer, mime: b.mime });
      }
    } catch { /* never into the page */ }
    return sb;
  };

  const appendBuffer = SourceBuffer.prototype.appendBuffer;
  SourceBuffer.prototype.appendBuffer = function (data) {
    try {
      const b = buffers.get(this);
      if (b) {
        const view = ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
        const bytes = view.slice();
        const init = isInit(bytes);
        if (init) {
          b.init = bytes;
          b.appends = [];
          b.bytes = 0;
          b.cut = false;
        } else {
          b.appends.push(bytes);
          b.bytes += bytes.length;
          while (b.bytes > KEEP_BYTES && b.appends.length > 1) {
            const old = b.appends.shift();
            if (old) b.bytes -= old.length;
            b.cut = true;
          }
        }
        if (b.source === following) send({ type: 'append', buffer: b.buffer, bytes, init });
      }
    } catch { /* never into the page */ }
    return appendBuffer.apply(this, arguments);
  };

  const abort = SourceBuffer.prototype.abort;
  SourceBuffer.prototype.abort = function () {
    try {
      const b = buffers.get(this);
      if (b) {
        // A null marks the restart in what's kept
        b.appends.push(null);
        if (b.source === following) send({ type: 'gap', buffer: b.buffer });
      }
    } catch { /* never into the page */ }
    return abort.apply(this, arguments);
  };

  function follow(url) {
    following = url && byUrl.has(url) ? byUrl.get(url) : null;
    send({ type: 'following', url, found: following !== null });
    // What's kept of the source's audio so far
    for (const b of sources.get(following) ?? []) {
      send({ type: 'buffer', buffer: b.buffer, mime: b.mime });
      if (b.init) send({ type: 'append', buffer: b.buffer, bytes: b.init, init: true });
      if (b.cut) send({ type: 'gap', buffer: b.buffer });
      for (const bytes of b.appends) send(bytes ? { type: 'append', buffer: b.buffer, bytes, init: false } : { type: 'gap', buffer: b.buffer });
    }
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window || e.data?.type !== HELLO || !e.ports?.[0]) return;
    e.stopImmediatePropagation();
    port = e.ports[0];
    following = null;
    port.onmessage = (m) => {
      if (m.data && 'follow' in m.data) follow(m.data.follow);
    };
  });
})();
