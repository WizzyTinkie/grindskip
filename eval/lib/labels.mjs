// Speech labels from YouTube's auto-generated captions (json3): when
// someone talks, in seconds from the start of a clip. Word starts come from
// the captions; a word ends where the next starts, at most maxWordSec later,
// or at the end of its caption line. Tags such as [Music] aren't speech.
import { readFileSync } from 'node:fs';

export function loadWords(path, maxWordSec = 0.6) {
  const { events } = JSON.parse(readFileSync(path, 'utf8'));
  const words = [];
  for (const ev of events) {
    if (!ev.segs || ev.aAppend) continue;
    const evEnd = (ev.tStartMs + (ev.dDurationMs || 0)) / 1000;
    for (const seg of ev.segs) {
      const word = seg.utf8.trim();
      if (!word || /^\[.*\]$/.test(word)) continue;
      words.push({ t: (ev.tStartMs + (seg.tOffsetMs || 0)) / 1000, evEnd, word });
    }
  }
  words.sort((a, b) => a.t - b.t);
  return words.map((w, i) => {
    const next = i + 1 < words.length ? words[i + 1].t : w.evEnd;
    return { t: w.t, end: Math.min(next, w.evEnd, w.t + maxWordSec), word: w.word };
  });
}

// Speech intervals [start, end] within the clip, merging words less than
// bridgeSec apart.
export function speechIntervals(words, { offset = 0, sec = Infinity, bridgeSec = 0.3 } = {}) {
  const out = [];
  for (const w of words) {
    const t = w.t - offset;
    const end = w.end - offset;
    if (end <= 0 || t >= sec) continue;
    const last = out.at(-1);
    if (last && t - last[1] < bridgeSec) last[1] = Math.max(last[1], end);
    else out.push([Math.max(0, t), end]);
  }
  for (const iv of out) iv[1] = Math.min(iv[1], sec);
  return out;
}

export function labelsFor(clip, root) {
  return speechIntervals(loadWords(new URL(clip.subs, root).pathname), clip);
}

// A lookup over intervals: is t inside one, and how far is it from speech?
export function labelIndex(intervals) {
  const speechAt = (t) => intervals.some(([a, b]) => t >= a && t < b);
  const distance = (t) => {
    let d = Infinity;
    for (const [a, b] of intervals) d = Math.min(d, t < a ? a - t : t >= b ? t - b : 0);
    return d;
  };
  return { intervals, speechAt, distance };
}
