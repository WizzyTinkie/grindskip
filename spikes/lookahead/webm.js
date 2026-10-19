// A streaming WebM demuxer for audio, enough for what YouTube appends to an
// audio SourceBuffer: the codec and its setup from the init segment, then
// each frame with its timestamp from the clusters. Appends may split
// elements anywhere, so bytes are kept until an element is complete.
//
// Master elements are stepped into without tracking where they end (their
// children's IDs are distinct), so a Segment or Cluster of unknown size is
// no problem. Only unlaced blocks are read, which is what YouTube's Opus
// streams use; laced ones are counted and skipped.

const MASTER = new Set([
  0x18538067, // Segment
  0x1549a966, // Info
  0x1654ae6b, // Tracks
  0xae,       // TrackEntry
  0xe1,       // Audio
  0x1f43b675, // Cluster
  0xa0,       // BlockGroup
]);

export function createWebmDemuxer() {
  let buf = new Uint8Array(0);
  let pos = 0;
  let scale = 1e6;            // TimecodeScale, in ns
  let cluster = 0;            // the current Cluster's Timecode
  let entry = {};             // the TrackEntry being read
  const tracks = new Map();   // number -> { codec, setup, sampleRate, channels }
  let laced = 0;

  // A variable-length integer at p: { value, length }, or null if the
  // bytes aren't all there; keepMarker for element IDs
  function vint(p, keepMarker) {
    if (p >= buf.length) return null;
    const first = buf[p];
    let length = 1;
    while (length <= 8 && !(first & (0x80 >> (length - 1)))) length++;
    if (length > 8 || p + length > buf.length) return null;
    let value = keepMarker ? first : first & (0xff >> length);
    let allOnes = value === (0xff >> length);
    for (let i = 1; i < length; i++) {
      value = value * 256 + buf[p + i];
      if (buf[p + i] !== 0xff) allOnes = false;
    }
    return { value, length, unknown: !keepMarker && allOnes };
  }

  const uint = (d) => d.reduce((v, b) => v * 256 + b, 0);
  const float = (d) => (d.length === 4 ? new DataView(d.buffer, d.byteOffset, 4).getFloat32(0) : new DataView(d.buffer, d.byteOffset, 8).getFloat64(0));

  function leaf(id, data, frames) {
    switch (id) {
      case 0x2ad7b1: scale = uint(data); break;                       // TimecodeScale
      case 0xd7: entry.number = uint(data); break;                    // TrackNumber
      case 0x86: entry.codec = new TextDecoder().decode(data); break;  // CodecID
      case 0x63a2: entry.setup = data.slice(); break;                 // CodecPrivate
      case 0xb5: entry.sampleRate = float(data); break;               // SamplingFrequency
      case 0x9f: entry.channels = uint(data); break;                  // Channels
      case 0xe7: cluster = uint(data); break;                         // Timecode
      case 0xa3: case 0xa1: {                                         // SimpleBlock, Block
        const view = data;
        // The block's own header: track number, relative timecode, flags
        let n;
        let len = 1;
        while (len <= 8 && !(view[0] & (0x80 >> (len - 1)))) len++;
        n = view[0] & (0xff >> len);
        for (let i = 1; i < len; i++) n = n * 256 + view[i];
        const rel = (view[len] << 8 | view[len + 1]) << 16 >> 16;
        const flags = view[len + 2];
        if (flags & 0x06) {
          laced++;
          break;
        }
        frames.push({ track: n, timestamp: (cluster + rel) * scale / 1e9, data: view.slice(len + 3) });
        break;
      }
      default:
    }
  }

  return {
    get tracks() { return tracks; },
    get laced() { return laced; },
    // Feeds the next appended bytes; returns the frames completed by them
    push(bytes) {
      const next = new Uint8Array(buf.length - pos + bytes.length);
      next.set(buf.subarray(pos));
      next.set(bytes, buf.length - pos);
      buf = next;
      pos = 0;
      const frames = [];
      for (;;) {
        const id = vint(pos, true);
        if (!id) break;
        const size = vint(pos + id.length, false);
        if (!size) break;
        const start = pos + id.length + size.length;
        if (MASTER.has(id.value)) {
          if (id.value === 0xae) {
            if (entry.number !== undefined) tracks.set(entry.number, entry);
            entry = {};
          }
          pos = start;
          continue;
        }
        if (size.unknown) throw new Error(`leaf element ${id.value.toString(16)} of unknown size`);
        if (start + size.value > buf.length) break;
        leaf(id.value, buf.subarray(start, start + size.value), frames);
        pos = start + size.value;
        // A TrackEntry ends where the next element outside it begins; the
        // first block or cluster is a safe point to file the last one
        if ((id.value === 0xe7 || id.value === 0xa3) && entry.number !== undefined) {
          tracks.set(entry.number, entry);
          entry = {};
        }
      }
      return frames;
    },
  };
}
