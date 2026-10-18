// Word timings from YouTube auto-generated captions (json3).
import { readFileSync } from 'node:fs';

// Returns [{ t, end, word }] in seconds. A word ends where the next one
// starts, capped at maxWordSec, or at the end of its caption event.
export function loadWords(path, maxWordSec = 0.6) {
  const { events } = JSON.parse(readFileSync(path, 'utf8'));
  const words = [];
  for (const ev of events) {
    if (!ev.segs || ev.aAppend) continue;
    const evEnd = (ev.tStartMs + (ev.dDurationMs || 0)) / 1000;
    for (const seg of ev.segs) {
      const word = seg.utf8.trim();
      if (!word) continue;
      words.push({ t: (ev.tStartMs + (seg.tOffsetMs || 0)) / 1000, evEnd, word });
    }
  }
  words.sort((a, b) => a.t - b.t);
  return words.map((w, i) => {
    const next = i + 1 < words.length ? words[i + 1].t : w.evEnd;
    return { t: w.t, end: Math.min(next, w.evEnd, w.t + maxWordSec), word: w.word };
  });
}

// Merges word spans into speech intervals, bridging gaps under bridgeSec.
export function speechIntervals(words, bridgeSec = 0.3) {
  const out = [];
  for (const w of words) {
    const last = out[out.length - 1];
    if (last && w.t - last[1] < bridgeSec) last[1] = Math.max(last[1], w.end);
    else out.push([w.t, w.end]);
  }
  return out;
}
