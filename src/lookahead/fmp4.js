// A streaming fragmented-MP4 demuxer for audio, the counterpart of webm.js
// for what HLS and DASH players (hls.js, Shaka, dash.js, video.js) and
// YouTube's AAC streams append: the tracks and their setup from the init
// segment (moov), then each audio sample with its timestamp from the
// fragments (moof + mdat). Appends may split boxes anywhere, so bytes are
// kept until a box is complete, and a moof until its mdat is.
//
// Only sound tracks ('soun') yield samples, so a buffer with video in it
// works too. Fragments with an absolute base data offset can't be placed in
// a stream of appends; they are counted and skipped.

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'mvex', 'moof', 'traf', 'sinf', 'wave']);

const u32 = (b, p) => ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;
const u64 = (b, p) => u32(b, p) * 2 ** 32 + u32(b, p + 4);
const u16 = (b, p) => (b[p] << 8) | b[p + 1];
const i32 = (b, p) => u32(b, p) | 0;
const fourcc = (b, p) => String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3]);

// The boxes in b[start, end) as { type, start, body, end }, up to the
// first incomplete one
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
    out.push({ type: fourcc(b, p + 4), start: p, body: p + head, end: p + size });
    p += size;
  }
  return out;
}

// An MPEG-4 descriptor's length: up to four 7-bit groups
function descriptorLength(b, p) {
  let n = 0;
  let i = 0;
  for (; i < 4; i++) {
    n = (n << 7) | (b[p + i] & 0x7f);
    if (!(b[p + i] & 0x80)) break;
  }
  return { n, length: i + 1 };
}

// esds: the object type and its DecoderSpecificInfo (for AAC, the
// AudioSpecificConfig)
function esds(b, p, end) {
  p += 4;
  let objectType = null;
  let info = null;
  while (p < end) {
    const tag = b[p];
    const { n, length } = descriptorLength(b, p + 1);
    const body = p + 1 + length;
    if (tag === 0x03) {
      // ES_Descriptor: its ID, flags and optional fields, then children
      const flags = b[body + 2];
      p = body + 3;
      if (flags & 0x80) p += 2;
      if (flags & 0x40) p += 1 + b[p];
      if (flags & 0x20) p += 2;
      continue;
    }
    if (tag === 0x04) {
      // DecoderConfigDescriptor: 13 bytes, then children
      objectType = b[body];
      p = body + 13;
      continue;
    }
    if (tag === 0x05) info = b.slice(body, body + n);
    p = body + n;
  }
  return { objectType, info };
}

// The audio object type, output sample rate and channels an
// AudioSpecificConfig declares. With explicit SBR signalling (HE-AAC) the
// rate is the SBR rate; with implicit SBR the decoder may still output
// twice the rate declared.
const RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
export function parseAudioSpecificConfig(asc) {
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
  if (aot === 5 || aot === 29) sampleRate = rate();
  return { aot, sampleRate, channels };
}

// dOps (Opus in MP4, big-endian) as an OpusHead (what WebCodecs takes,
// little-endian)
function opusHead(b, p, end) {
  const channels = b[p + 1];
  const family = b[p + 10];
  const head = new Uint8Array(19 + (family ? 2 + channels : 0));
  head.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64, 1, channels]);
  const v = new DataView(head.buffer);
  v.setUint16(10, u16(b, p + 2), true);
  v.setUint32(12, u32(b, p + 4), true);
  v.setInt16(16, (u16(b, p + 8) << 16) >> 16, true);
  head[18] = family;
  if (family) head.set(b.subarray(p + 11, Math.min(end, p + 13 + channels)), 19);
  return head;
}

// An audio sample entry (mp4a, Opus, enca, ...): the codec as WebCodecs
// names it, and its description
function sampleEntry(b, box, track) {
  track.encrypted = box.type === 'enca';
  // 8 bytes of SampleEntry, then the AudioSampleEntry fields; QuickTime's
  // versions 1 and 2 have more
  const version = u16(b, box.body + 8);
  track.channels = u16(b, box.body + 16);
  track.sampleRate = u32(b, box.body + 24) >>> 16;
  let format = box.type;
  const walk = (start, end) => {
    for (const c of boxes(b, start, end)) {
      if (c.type === 'esds') {
        const { objectType, info } = esds(b, c.body, c.end);
        if ((objectType === 0x40 || objectType === 0x66 || objectType === 0x67) && info?.length >= 2) {
          const asc = parseAudioSpecificConfig(info);
          track.codec = `mp4a.40.${asc.aot}`;
          track.description = info;
          if (asc.sampleRate) track.sampleRate = asc.sampleRate;
          if (asc.channels) track.channels = asc.channels;
        } else if (objectType !== null) {
          track.codec = `mp4a.${objectType.toString(16)}`;
        }
      } else if (c.type === 'dOps') {
        track.codec = 'opus';
        track.description = opusHead(b, c.body, c.end);
      } else if (c.type === 'frma') {
        format = fourcc(b, c.body);
      } else if (c.type === 'sinf' || c.type === 'wave') {
        walk(c.body, c.end);
      }
    }
  };
  walk(box.body + 28 + (version === 1 ? 16 : version === 2 ? 36 : 0), box.end);
  track.codec ??= format;
}

export function createMp4Demuxer() {
  let buf = new Uint8Array(0);
  let pos = 0;
  let resync = false;         // skip to the next moof before reading
  let moof = null;            // { start, samples } waiting for its mdat
  const tracks = new Map();   // number -> { number, handler, timescale, codec, description, sampleRate, channels, encrypted }
  const defaults = new Map(); // track number -> its trex { duration, size }
  let skipped = 0;

  function trak(b, box) {
    const track = { number: null, handler: null, timescale: null, codec: null };
    const walk = (start, end) => {
      for (const c of boxes(b, start, end)) {
        const v1 = b[c.body] === 1;
        if (c.type === 'tkhd') track.number = u32(b, c.body + (v1 ? 20 : 12));
        else if (c.type === 'mdhd') track.timescale = u32(b, c.body + (v1 ? 20 : 12));
        else if (c.type === 'hdlr') track.handler = fourcc(b, c.body + 8);
        else if (c.type === 'stsd') {
          const entry = boxes(b, c.body + 8, c.end)[0];
          if (entry && track.handler === 'soun') sampleEntry(b, entry, track);
        } else if (CONTAINERS.has(c.type)) walk(c.body, c.end);
      }
    };
    walk(box.body, box.end);
    if (track.number !== null && track.timescale) tracks.set(track.number, track);
  }

  function moov(b, box) {
    for (const c of boxes(b, box.body, box.end)) {
      if (c.type === 'trak') trak(b, c);
      if (c.type !== 'mvex') continue;
      for (const t of boxes(b, c.body, c.end)) {
        if (t.type === 'trex') defaults.set(u32(b, t.body + 4), { duration: u32(b, t.body + 12), size: u32(b, t.body + 16) });
      }
    }
  }

  // The moof's samples as { track, offset (from the moof's start), size,
  // time and duration (in the track's timescale) }
  function fragment(b, box) {
    const samples = [];
    for (const traf of boxes(b, box.body, box.end)) {
      if (traf.type !== 'traf') continue;
      let track = null;
      let def = {};
      let time = 0;
      let next = 0;           // where a trun without a data offset starts
      for (const c of boxes(b, traf.body, traf.end)) {
        if (c.type === 'tfhd') {
          const flags = u32(b, c.body) & 0xffffff;
          if (flags & 0x1) {
            skipped++;
            break;
          }
          track = u32(b, c.body + 4);
          def = { ...defaults.get(track) };
          let p = c.body + 8;
          if (flags & 0x2) p += 4;
          if (flags & 0x8) { def.duration = u32(b, p); p += 4; }
          if (flags & 0x10) def.size = u32(b, p);
        } else if (c.type === 'tfdt') {
          time = b[c.body] === 1 ? u64(b, c.body + 4) : u32(b, c.body + 4);
        } else if (c.type === 'trun' && track !== null) {
          const flags = u32(b, c.body) & 0xffffff;
          const n = u32(b, c.body + 4);
          let p = c.body + 8;
          let offset = next;
          if (flags & 0x1) { offset = i32(b, p); p += 4; }
          if (flags & 0x4) p += 4;
          for (let i = 0; i < n; i++) {
            let duration = def.duration;
            let size = def.size;
            let cto = 0;
            if (flags & 0x100) { duration = u32(b, p); p += 4; }
            if (flags & 0x200) { size = u32(b, p); p += 4; }
            if (flags & 0x400) p += 4;
            if (flags & 0x800) { cto = i32(b, p); p += 4; }
            samples.push({ track, offset, size, time: time + cto, duration });
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
    get skipped() { return skipped; },
    // Drops the bytes not read yet; with resync, reading starts again at
    // the next moof (after appends were missed, or the SourceBuffer was
    // aborted). The tracks are kept.
    reset({ resync: skip = true } = {}) {
      buf = new Uint8Array(0);
      pos = 0;
      moof = null;
      resync = skip;
    },
    // Feeds the next appended bytes; returns the audio samples completed by
    // them as { track, timestamp, duration (s), data }
    push(bytes) {
      // From a pending moof on, bytes stay: its sample offsets are from it
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
      while (pos + 8 <= buf.length) {
        let size = u32(buf, pos);
        if (size === 1) {
          if (pos + 16 > buf.length) break;
          size = u64(buf, pos + 8);
        }
        const type = fourcc(buf, pos + 4);
        if (size < 8) throw new Error(`MP4: box ${type} of size ${size}`);
        if (pos + size > buf.length) break;
        const box = boxes(buf, pos, pos + size)[0];
        if (type === 'moov') {
          moov(buf, box);
        } else if (type === 'moof') {
          moof = { start: box.start, samples: fragment(buf, box) };
        } else if (type === 'mdat' && moof) {
          for (const s of moof.samples) {
            const track = tracks.get(s.track);
            const at = moof.start + s.offset;
            if (track?.handler !== 'soun') continue;
            if (at < box.body || at + s.size > box.end) {
              skipped++;
              continue;
            }
            frames.push({ track: s.track, timestamp: s.time / track.timescale, duration: s.duration / track.timescale, data: buf.slice(at, at + s.size) });
          }
          moof = null;
        }
        pos = box.end;
      }
      return frames;
    },
  };
}
