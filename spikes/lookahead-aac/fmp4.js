// A streaming fragmented-MP4 demuxer for audio, the counterpart of
// lookahead/webm.js: the tracks and their setup from the init segment
// (moov), then each audio sample with its timestamp from the fragments
// (moof + mdat). Appends may split boxes anywhere, so bytes are kept until
// a box is complete; a moof is held until its mdat is.
//
// Tracks: { id, handler, timescale, codec, description, sampleRate,
// channels, encrypted, edit } where codec is a WebCodecs string
// ('mp4a.40.2', 'opus', 'mp3', ...), description what AudioDecoder wants
// for it (AudioSpecificConfig, OpusHead), and edit the first edit list
// entry's media time in seconds (null if none). Only 'soun' tracks yield
// samples, so a buffer with video in it works too.

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'mvex', 'edts', 'moof', 'traf', 'sinf', 'wave']);

const u32 = (b, p) => ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;
const u64 = (b, p) => u32(b, p) * 2 ** 32 + u32(b, p + 4);
const u16 = (b, p) => (b[p] << 8) | b[p + 1];
const i32 = (b, p) => u32(b, p) | 0;
const type = (b, p) => String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3]);

// The boxes in b[start, end): [{ type, start, body, end }]; stops at an
// incomplete one
function boxes(b, start, end) {
  const out = [];
  let p = start;
  while (p + 8 <= end) {
    let size = u32(b, p);
    let head = 8;
    if (size === 1) {
      if (p + 16 > end) break;
      size = u64(b, p + 8);
      head = 16;
    } else if (size === 0) {
      size = end - p;
    }
    if (size < head || p + size > end) break;
    out.push({ type: type(b, p + 4), start: p, body: p + head, end: p + size });
    p += size;
  }
  return out;
}

// MPEG-4 descriptor length: up to four 7-bit groups
function descLen(b, p) {
  let n = 0;
  let i = 0;
  for (; i < 4; i++) {
    n = (n << 7) | (b[p + i] & 0x7f);
    if (!(b[p + i] & 0x80)) break;
  }
  return { n, len: i + 1 };
}

// esds: the DecoderSpecificInfo (an AudioSpecificConfig for AAC) and the
// object type
function esds(b, p, end) {
  p += 4;   // version, flags
  let objectType = null;
  let asc = null;
  while (p < end) {
    const tag = b[p];
    const { n, len } = descLen(b, p + 1);
    const body = p + 1 + len;
    if (tag === 0x03) {
      const flags = b[body + 2];
      let q = body + 3;
      if (flags & 0x80) q += 2;
      if (flags & 0x40) q += 1 + b[q];
      if (flags & 0x20) q += 2;
      p = q;
      continue;
    }
    if (tag === 0x04) {
      objectType = b[body];
      p = body + 13;
      continue;
    }
    if (tag === 0x05) asc = b.slice(body, body + n);
    p = body + n;
  }
  return { objectType, asc };
}

// The audio object type, sample rate and channels an AudioSpecificConfig
// declares; with SBR (HE-AAC) the rate is the output rate
const RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
export function parseAsc(asc) {
  let bit = 0;
  const read = (n) => {
    let v = 0;
    for (let i = 0; i < n; i++, bit++) v = (v << 1) | ((asc[bit >> 3] >> (7 - (bit & 7))) & 1);
    return v;
  };
  const objectType = () => {
    const t = read(5);
    return t === 31 ? 32 + read(6) : t;
  };
  const rate = () => {
    const i = read(4);
    return i === 15 ? read(24) : RATES[i];
  };
  const aot = objectType();
  let sampleRate = rate();
  const channels = read(4);
  const sbr = aot === 5 || aot === 29;
  if (sbr) sampleRate = rate();
  return { aot, sampleRate, channels, sbr };
}

// dOps (Opus in MP4, big-endian) to OpusHead (what WebCodecs takes,
// little-endian)
function opusHead(b, p, end) {
  const channels = b[p + 1];
  const head = new Uint8Array(19 + (b[p + 10] ? 2 + channels : 0));
  head.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64, 1, channels]);
  const v = new DataView(head.buffer);
  v.setUint16(10, u16(b, p + 2), true);
  v.setUint32(12, u32(b, p + 4), true);
  v.setInt16(16, (u16(b, p + 8) << 16) >> 16, true);
  head[18] = b[p + 10];
  if (b[p + 10]) head.set(b.subarray(p + 11, Math.min(end, p + 13 + channels)), 19);
  return head;
}

function sampleEntry(b, box, track) {
  let fmt = box.type;
  track.encrypted = fmt === 'enca';
  // Audio sample entry: 8 bytes SampleEntry, then version 0/1/2 fields
  const version = u16(b, box.body + 8);
  track.channels = u16(b, box.body + 16);
  track.sampleRate = u32(b, box.body + 24) >>> 16;
  const children = box.body + 28 + (version === 1 ? 16 : version === 2 ? 36 : 0);
  const walk = (start, end) => {
    for (const c of boxes(b, start, end)) {
      if (c.type === 'esds') {
        const { objectType, asc } = esds(b, c.body, c.end);
        track.objectType = objectType;
        if (objectType === 0x40 || objectType === 0x66 || objectType === 0x67) {
          const a = parseAsc(asc);
          track.codec = `mp4a.40.${a.aot}`;
          track.description = asc;
          track.sampleRate = a.sampleRate;
          if (a.channels) track.channels = a.channels;
        } else if (objectType === 0x69 || objectType === 0x6b) {
          track.codec = 'mp3';
        } else {
          track.codec = `mp4a.${objectType.toString(16)}`;
        }
      } else if (c.type === 'dOps') {
        track.codec = 'opus';
        track.description = opusHead(b, c.body, c.end);
      } else if (c.type === 'frma') {
        fmt = type(b, c.body);
      } else if (c.type === 'sinf' || c.type === 'wave') {
        walk(c.body, c.end);
      }
    }
  };
  walk(children, box.end);
  track.format = fmt;
  if (!track.codec) track.codec = { 'ac-3': 'ac-3', 'ec-3': 'ec-3', fLaC: 'flac', Opus: 'opus', '.mp3': 'mp3' }[fmt] ?? fmt;
}

export function createMp4Demuxer() {
  let buf = new Uint8Array(0);
  let pos = 0;
  let resync = false;
  const tracks = new Map();   // track id -> track
  const trex = new Map();     // track id -> defaults
  let moof = null;            // a parsed moof waiting for its mdat
  const counts = { moofs: 0, samples: 0, skipped: 0, boxes: {} };

  function parseTrak(b, trak) {
    const track = { id: null, handler: null, timescale: null, codec: null, edit: null };
    const walk = (start, end) => {
      for (const c of boxes(b, start, end)) {
        if (c.type === 'tkhd') track.id = u32(b, c.body + 4 + (b[c.body] === 1 ? 16 : 8));
        else if (c.type === 'mdhd') track.timescale = u32(b, c.body + 4 + (b[c.body] === 1 ? 16 : 8));
        else if (c.type === 'hdlr') track.handler = type(b, c.body + 8);
        else if (c.type === 'elst') {
          const v1 = b[c.body] === 1;
          const n = u32(b, c.body + 4);
          const entries = [];
          for (let i = 0, p = c.body + 8; i < n; i++, p += v1 ? 20 : 12) {
            entries.push({ duration: v1 ? u64(b, p) : u32(b, p), mediaTime: v1 ? u64(b, p + 8) : i32(b, p + 4) });
          }
          track.edits = entries;
        } else if (c.type === 'stsd') {
          const entry = boxes(b, c.body + 8, c.end)[0];
          if (entry) sampleEntry(b, entry, track);
        } else if (CONTAINERS.has(c.type)) walk(c.body, c.end);
      }
    };
    walk(trak.body, trak.end);
    const media = track.edits?.find((e) => e.mediaTime !== -1 && e.mediaTime !== 0xffffffff);
    if (media && track.timescale) track.edit = media.mediaTime / track.timescale;
    if (track.id !== null) tracks.set(track.id, track);
  }

  function parseMoov(b, box) {
    for (const c of boxes(b, box.body, box.end)) {
      if (c.type === 'trak') parseTrak(b, c);
      else if (c.type === 'mvex') {
        for (const t of boxes(b, c.body, c.end)) {
          if (t.type !== 'trex') continue;
          trex.set(u32(b, t.body + 4), { duration: u32(b, t.body + 12), size: u32(b, t.body + 16) });
        }
      }
    }
  }

  // The moof's samples as { track, offset (from the moof's start), size,
  // time (in the track's timescale), duration }
  function parseMoof(b, box) {
    const samples = [];
    for (const traf of boxes(b, box.body, box.end)) {
      if (traf.type !== 'traf') continue;
      let id = null;
      let def = {};
      let base = 0;           // the base data offset, from the moof's start
      let time = null;
      let next = null;        // where a trun without a data offset starts
      for (const c of boxes(b, traf.body, traf.end)) {
        if (c.type === 'tfhd') {
          const flags = u32(b, c.body) & 0xffffff;
          id = u32(b, c.body + 4);
          def = { ...trex.get(id) };
          let p = c.body + 8;
          if (flags & 0x1) {
            // An absolute offset: can't be placed in a stream of appends
            counts.skipped++;
            id = null;
            break;
          }
          if (flags & 0x2) p += 4;
          if (flags & 0x8) { def.duration = u32(b, p); p += 4; }
          if (flags & 0x10) { def.size = u32(b, p); p += 4; }
        } else if (c.type === 'tfdt') {
          time = b[c.body] === 1 ? u64(b, c.body + 4) : u32(b, c.body + 4);
        } else if (c.type === 'trun' && id !== null) {
          const flags = u32(b, c.body) & 0xffffff;
          const n = u32(b, c.body + 4);
          let p = c.body + 8;
          let offset = next ?? base;
          if (flags & 0x1) { offset = base + i32(b, p); p += 4; }
          if (flags & 0x4) p += 4;
          for (let i = 0; i < n; i++) {
            const duration = flags & 0x100 ? u32(b, (p += 4) - 4) : def.duration;
            const size = flags & 0x200 ? u32(b, (p += 4) - 4) : def.size;
            if (flags & 0x400) p += 4;
            let cto = 0;
            if (flags & 0x800) cto = i32(b, (p += 4) - 4);
            samples.push({ track: id, offset, size, time: time + cto, duration });
            offset += size;
            time += duration;
          }
          next = offset;
        }
      }
    }
    return samples;
  }

  // Moves pos to the next moof; false if there's none yet
  function findMoof() {
    for (let i = Math.max(pos, 4); i + 4 <= buf.length; i++) {
      if (buf[i] === 0x6d && buf[i + 1] === 0x6f && buf[i + 2] === 0x6f && buf[i + 3] === 0x66) {
        pos = i - 4;
        return true;
      }
    }
    pos = Math.max(pos, buf.length - 7);
    return false;
  }

  return {
    get tracks() { return tracks; },
    get counts() { return counts; },
    // Drops the bytes not read yet; with resync, reading starts again at
    // the next moof. The tracks are kept.
    reset({ resync: skip = true } = {}) {
      buf = new Uint8Array(0);
      pos = 0;
      moof = null;
      resync = skip;
    },
    // Feeds the next appended bytes; returns the audio samples completed by
    // them as { track, timestamp, duration (s), data }
    push(bytes) {
      // Bytes from a pending moof on stay: its sample offsets are from it
      const keep = moof ? moof.start : pos;
      const next = new Uint8Array(buf.length - keep + bytes.length);
      next.set(buf.subarray(keep));
      next.set(bytes, buf.length - keep);
      buf = next;
      pos -= keep;
      if (moof) moof.start = 0;
      const frames = [];
      if (resync) {
        if (!findMoof()) return frames;
        resync = false;
      }
      for (;;) {
        // Box headers only: the body may not be here yet
        if (pos + 8 > buf.length) break;
        let size = u32(buf, pos);
        if (size === 1) {
          if (pos + 16 > buf.length) break;
          size = u64(buf, pos + 8);
        }
        const t = type(buf, pos + 4);
        if (size < 8) throw new Error(`MP4: box ${t} of size ${size}`);
        if (pos + size > buf.length) break;
        const box = boxes(buf, pos, pos + size)[0];
        counts.boxes[t] = (counts.boxes[t] ?? 0) + 1;
        if (t === 'moov') {
          parseMoov(buf, box);
        } else if (t === 'moof') {
          // The sample offsets are from here; keep it till its mdat
          moof = { start: box.start, samples: parseMoof(buf, box) };
          counts.moofs++;
        } else if (t === 'mdat' && moof) {
          for (const s of moof.samples) {
            const track = tracks.get(s.track);
            if (track?.handler !== 'soun') continue;
            const at = moof.start + s.offset;
            if (at < box.body || at + s.size > box.end) {
              counts.skipped++;
              continue;
            }
            frames.push({ track: s.track, timestamp: s.time / track.timescale, duration: s.duration / track.timescale, data: buf.slice(at, at + s.size) });
            counts.samples++;
          }
          moof = null;
        }
        pos = box.end;
      }
      return frames;
    },
  };
}
