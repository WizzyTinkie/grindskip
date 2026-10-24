// The content script's end of the page hook (page/hook.js): asks it for the
// followed video's audio and runs a look-ahead analysis (analysis.js) on
// each of its audio SourceBuffers.
import { HOOK_HELLO } from '../shared/messages.js';
import { canAnalyse, createAnalysis } from './analysis.js';

// The page sends these: numbers only
const num = (x, otherwise) => (typeof x === 'number' && !Number.isNaN(x) ? x : otherwise);

// createStream(): a Silero stream of its own for each analysis
export function createFeed(createStream) {
  const channel = new MessageChannel();
  const analyses = new Map();   // buffer id -> { mime, analysis }
  let url = null;
  let found = null;             // whether the hook knows url's MediaSource

  channel.port1.onmessage = (e) => {
    const m = e.data;
    if (m?.type === 'following') {
      if (m.url === url) found = m.found;
    } else if (m?.type === 'buffer') {
      if (analyses.has(m.buffer)) return;
      const supported = canAnalyse(m.mime);
      analyses.set(m.buffer, { mime: m.mime, analysis: supported ? createAnalysis(m.mime, createStream()) : null });
    } else if (m?.type === 'mime') {
      const entry = analyses.get(m.buffer);
      if (!entry) return;
      entry.mime = m.mime;
      if (!canAnalyse(m.mime)) {
        entry.analysis?.stop();
        entry.analysis = null;
      } else if (entry.analysis) {
        entry.analysis.changeType(m.mime);
      } else {
        entry.analysis = createAnalysis(m.mime, createStream());
      }
    } else if (m?.type === 'append') {
      // A copy of our own: in Firefox the message's arrays may belong to
      // the page
      const bytes = new Uint8Array(m.bytes.length);
      bytes.set(m.bytes);
      analyses.get(m.buffer)?.analysis?.push(bytes, { init: !!m.init, offset: num(m.offset, 0), windowStart: num(m.windowStart, 0), windowEnd: num(m.windowEnd, Infinity) });
    } else if (m?.type === 'gap') {
      analyses.get(m.buffer)?.analysis?.gap();
    }
  };
  window.postMessage({ type: HOOK_HELLO }, '*', [channel.port2]);

  function stopAll() {
    for (const { analysis } of analyses.values()) analysis?.stop();
    analyses.clear();
  }

  return {
    // Follows the video playing from src (its currentSrc), or none
    follow(src) {
      const next = src && src.startsWith('blob:') ? src : null;
      if (next === url) return;
      stopAll();
      url = next;
      found = next ? null : false;
      channel.port1.postMessage({ follow: next });
    },
    // The followed video's analysis: its first audio buffer that can be
    // analysed, or null
    get analysis() {
      for (const { analysis } of analyses.values()) if (analysis) return analysis;
      return null;
    },
    status() {
      const a = this.analysis;
      return {
        url,
        found,
        buffers: [...analyses.values()].map((x) => x.mime),
        error: a?.error ?? null,
        analysed: a?.timeline.size ?? 0,
        decodedUntil: a?.decodedUntil ?? null,
        counts: a?.counts ?? null,
      };
    },
    close() {
      stopAll();
      channel.port1.postMessage({ follow: null });
      channel.port1.close();
    },
  };
}
