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
// Audio buffers are the audio/ ones and those whose codecs are all audio
// ones: some players label theirs video/mp4.
//
// Each append goes with the timestampOffset that applied to it: the one set
// before it, or in "sequence" mode, where the browser sets it itself, the
// one after it (so those appends are passed on once the browser is done).
//
// Protocol: the content script posts { type: HELLO } to the window with a
// MessagePort. On that port it sends { follow: url } (the followed video's
// currentSrc, or null for none) and receives
//   { type: 'following', url, found }   whether url is a MediaSource's
//   { type: 'buffer', buffer, mime }    an audio SourceBuffer of it
//   { type: 'mime', buffer, mime }      its type changed (changeType); an
//                                       init segment follows
//   { type: 'append', buffer, bytes, init, offset, windowStart, windowEnd }
//                                       bytes appended to one (init: an init
//                                       segment), with its timestampOffset
//                                       and append window
//   { type: 'gap', buffer }             appends were missed or aborted: the
//                                       next one starts afresh
import { isAudioOnly } from '../lookahead/codecs.js';

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
    || (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70)                   // MP4 ftyp
    || (b[4] === 0x6d && b[5] === 0x6f && b[6] === 0x6f && b[7] === 0x76);                  // or moov
  const number = (x, otherwise) => (typeof x === 'number' && !Number.isNaN(x) ? x : otherwise);

  // Files an append in what's kept, and passes it on if followed
  function commit(b, entry) {
    if (entry.init) {
      b.init = entry;
      b.appends = [];
      b.bytes = 0;
      b.cut = false;
    } else {
      b.appends.push(entry);
      b.bytes += entry.bytes.length;
      while (b.bytes > KEEP_BYTES && b.appends.length > 1) {
        const old = b.appends.shift();
        if (old) b.bytes -= old.bytes.length;
        b.cut = true;
      }
    }
    if (b.source === following) send({ type: 'append', buffer: b.buffer, ...entry });
  }

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
      if (isAudioOnly(mime)) {
        const b = { buffer: nextId++, source: sourceId(this), mime: String(mime), init: null, appends: [], bytes: 0, cut: false, pending: null };
        buffers.set(sb, b);
        sources.get(b.source)?.push(b);
        if (b.source === following) send({ type: 'buffer', buffer: b.buffer, mime: b.mime });
        // A sequence-mode append, once the browser has set its offset
        sb.addEventListener?.('updateend', () => {
          try {
            if (!b.pending) return;
            b.pending.offset = number(sb.timestampOffset, 0);
            commit(b, b.pending);
            b.pending = null;
          } catch { /* never into the page */ }
        });
      }
    } catch { /* never into the page */ }
    return sb;
  };

  const appendBuffer = SourceBuffer.prototype.appendBuffer;
  SourceBuffer.prototype.appendBuffer = function (data) {
    const b = buffers.get(this);
    let entry = null;
    try {
      if (b) {
        const view = ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
        const bytes = view.slice();
        entry = {
          bytes,
          init: isInit(bytes),
          offset: number(this.timestampOffset, 0),
          windowStart: number(this.appendWindowStart, 0),
          windowEnd: number(this.appendWindowEnd, Infinity),
        };
      }
    } catch { /* never into the page */ }
    // Only what the browser took (it throws while still updating, or when full)
    const result = appendBuffer.apply(this, arguments);
    try {
      if (entry && this.mode === 'sequence' && this.addEventListener) b.pending = entry;
      else if (entry) commit(b, entry);
    } catch { /* never into the page */ }
    return result;
  };

  const abort = SourceBuffer.prototype.abort;
  SourceBuffer.prototype.abort = function () {
    try {
      const b = buffers.get(this);
      if (b) {
        // A null marks the restart in what's kept
        b.pending = null;
        b.appends.push(null);
        if (b.source === following) send({ type: 'gap', buffer: b.buffer });
      }
    } catch { /* never into the page */ }
    return abort.apply(this, arguments);
  };

  const changeType = SourceBuffer.prototype.changeType;
  if (changeType) {
    SourceBuffer.prototype.changeType = function (mime) {
      try {
        const b = buffers.get(this);
        if (b) {
          b.mime = String(mime);
          if (b.source === following) send({ type: 'mime', buffer: b.buffer, mime: b.mime });
        }
      } catch { /* never into the page */ }
      return changeType.apply(this, arguments);
    };
  }

  function follow(url) {
    following = url && byUrl.has(url) ? byUrl.get(url) : null;
    send({ type: 'following', url, found: following !== null });
    // What's kept of the source's audio so far
    for (const b of sources.get(following) ?? []) {
      send({ type: 'buffer', buffer: b.buffer, mime: b.mime });
      if (b.init) send({ type: 'append', buffer: b.buffer, ...b.init });
      if (b.cut) send({ type: 'gap', buffer: b.buffer });
      for (const entry of b.appends) send(entry ? { type: 'append', buffer: b.buffer, ...entry } : { type: 'gap', buffer: b.buffer });
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
