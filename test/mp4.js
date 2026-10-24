// A minimal fragmented-MP4 writer for the tests: an init segment with sound
// (and optionally video) tracks, and fragments of samples with given sizes
// and times, as HLS and DASH players append them.

const u32 = (n) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const u16 = (n) => [(n >> 8) & 0xff, n & 0xff];
const u64 = (n) => [...u32(Math.floor(n / 2 ** 32)), ...u32(n >>> 0)];
const text = (s) => [...s].map((c) => c.charCodeAt(0));
const flat = (parts) => parts.flatMap((p) => Array.from(p));

export function box(type, ...parts) {
  const body = flat(parts);
  return Uint8Array.from([...u32(8 + body.length), ...text(type), ...body]);
}
const full = (type, version, flags, ...parts) => box(type, [version, (flags >> 16) & 0xff, (flags >> 8) & 0xff, flags & 0xff], ...parts);
const descriptor = (tag, body) => [tag, body.length, ...body];

// AAC-LC's AudioSpecificConfig: object type 2, rate index, channels
export const lcConfig = (rateIndex = 4, channels = 2) => Uint8Array.of((2 << 3) | (rateIndex >> 1), ((rateIndex & 1) << 7) | (channels << 3));

function audioEntry(codec, rate, channels, setup) {
  const fields = [0, 0, 0, 0, 0, 0, ...u16(1), 0, 0, 0, 0, 0, 0, 0, 0, ...u16(channels), ...u16(16), 0, 0, 0, 0, ...u32(rate * 65536)];
  if (codec === 'opus') {
    return box('Opus', fields, box('dOps', [0, channels, ...u16(312), ...u32(rate), 0, 0, 0]));
  }
  const config = descriptor(0x04, [0x40, 0x15, 0, 0, 0, ...u32(0), ...u32(0), ...descriptor(0x05, Array.from(setup))]);
  return box(codec === 'enca' ? 'enca' : 'mp4a', fields, full('esds', 0, 0, descriptor(0x03, [0, 1, 0, ...config])));
}

function trak({ id, handler, timescale, codec = 'mp4a', rate = timescale, channels = 2, setup = lcConfig() }) {
  const entry = handler === 'soun' ? audioEntry(codec, rate, channels, setup) : box('avc1', new Uint8Array(78));
  return box('trak',
    full('tkhd', 0, 3, u32(0), u32(0), u32(id), new Uint8Array(68)),
    box('mdia',
      full('mdhd', 0, 0, u32(0), u32(0), u32(timescale), u32(0), u32(0)),
      full('hdlr', 0, 0, u32(0), text(handler), new Uint8Array(13)),
      box('minf', box('stbl', full('stsd', 0, 0, u32(1), entry)))));
}

// tracks: [{ id, handler: 'soun' | 'vide', timescale, codec?, rate?, channels?, setup?, duration }]
export function initSegment(tracks) {
  return Uint8Array.from([
    ...box('ftyp', text('iso6'), u32(0), text('iso6')),
    ...box('moov',
      full('mvhd', 0, 0, new Uint8Array(96)),
      ...tracks.map(trak),
      box('mvex', ...tracks.map((t) => full('trex', 0, 0, u32(t.id), u32(1), u32(t.duration ?? 1024), u32(0), u32(0))))),
  ]);
}

// A moof + mdat: for each track, samples of the given sizes from time
// (in its timescale), each of the trex duration; the sample bytes are
// [track id, sample index, ...]
export function fragment(parts) {
  const trafs = (offsets) => parts.map((p, i) => box('traf',
    full('tfhd', 0, 0x020000, u32(p.id)),
    full('tfdt', 1, 0, u64(p.time)),
    full('trun', 0, 0x201, u32(p.sizes.length), u32(offsets[i]), ...p.sizes.map((s) => u32(s)))));
  const data = parts.map((p) => p.sizes.flatMap((s, k) => Array.from({ length: s }, (_, j) => (j === 0 ? p.id : j === 1 ? k & 0xff : 7))));
  // Offsets are from the moof's start; its size doesn't depend on them
  const size = box('moof', full('mfhd', 0, 0, u32(1)), ...trafs(parts.map(() => 0))).length;
  const offsets = [];
  let at = size + 8;
  for (const d of data) {
    offsets.push(at);
    at += d.length;
  }
  return Uint8Array.from([...box('moof', full('mfhd', 0, 0, u32(1)), ...trafs(offsets)), ...box('mdat', flat(data))]);
}
