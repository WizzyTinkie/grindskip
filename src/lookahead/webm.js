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
const CLUSTER = [0x1f, 0x43, 0xb6, 0x75];

// A variable-length integer in bytes at p: { value, length, unknown }, or
// null if they aren't all there; keepMarker for element IDs
function vint(bytes, p, keepMarker) {
  if (p >= bytes.length) return null;
  const first = bytes[p];
  let length = 1;
  while (length <= 8 && !(first & (0x80 >> (length - 1)))) length++;
  if (length > 8 || p + length > bytes.length) return null;
  let value = keepMarker ? first : first & (0xff >> length);
  let allOnes = value === (0xff >> length);
  for (let i = 1; i < length; i++) {
    value = value * 256 + bytes[p + i];
    if (bytes[p + i] !== 0xff) allOnes = false;
  }
  return { value, length, unknown: !keepMarker && allOnes };
}

const uint = (d) => d.reduce((v, b) => v * 256 + b, 0);
function float(d) {
  const view = new DataView(d.buffer, d.byteOffset, d.length);
  return d.length === 4 ? view.getFloat32(0) : view.getFloat64(0);
}

export function createWebmDemuxer() {
  let buf = new Uint8Array(0);
  let pos = 0;
  let scale = 1e6;            // TimecodeScale, in ns
  let cluster = 0;            // the current Cluster's Timecode
  let entry = {};             // the TrackEntry being read
  let resync = false;         // skip to the next Cluster before reading
  const tracks = new Map();   // number -> { number, codec, setup, sampleRate, channels }
  let laced = 0;

  function fileEntry() {
    if (entry.number !== undefined) tracks.set(entry.number, entry);
    entry = {};
  }

  function block(data, frames) {
    const n = vint(data, 0, false);
    if (!n || data.length < n.length + 3) return;
    const rel = (data[n.length] << 8 | data[n.length + 1]) << 16 >> 16;
    const flags = data[n.length + 2];
    if (flags & 0x06) {
      laced++;
      return;
    }
    frames.push({ track: n.value, timestamp: (cluster + rel) * scale / 1e9, data: data.slice(n.length + 3) });
  }

  function leaf(id, data, frames) {
    switch (id) {
      case 0x2ad7b1: scale = uint(data); break;                        // TimecodeScale
      case 0xd7: entry.number = uint(data); break;                     // TrackNumber
      case 0x86: entry.codec = new TextDecoder().decode(data); break;   // CodecID
      case 0x63a2: entry.setup = data.slice(); break;                  // CodecPrivate
      case 0xb5: entry.sampleRate = float(data); break;                // SamplingFrequency
      case 0x9f: entry.channels = uint(data); break;                   // Channels
      case 0xe7: cluster = uint(data); break;                          // Timecode
      case 0xa3: case 0xa1: block(data, frames); break;                // SimpleBlock, Block
      default:
    }
  }

  // Moves pos to the next Cluster ID; false if there's none yet
  function findCluster() {
    for (let i = pos; i + 4 <= buf.length; i++) {
      if (buf[i] === CLUSTER[0] && buf[i + 1] === CLUSTER[1] && buf[i + 2] === CLUSTER[2] && buf[i + 3] === CLUSTER[3]) {
        pos = i;
        return true;
      }
    }
    pos = Math.max(pos, buf.length - 3);
    return false;
  }

  return {
    get tracks() { return tracks; },
    get laced() { return laced; },
    // Drops the bytes not read yet; with resync, reading starts again at
    // the next Cluster (after appends were missed, or the SourceBuffer was
    // aborted). The tracks are kept.
    reset({ resync: skip = true } = {}) {
      buf = new Uint8Array(0);
      pos = 0;
      resync = skip;
    },
    // Feeds the next appended bytes; returns the frames completed by them
    push(bytes) {
      const next = new Uint8Array(buf.length - pos + bytes.length);
      next.set(buf.subarray(pos));
      next.set(bytes, buf.length - pos);
      buf = next;
      pos = 0;
      const frames = [];
      if (resync) {
        if (!findCluster()) return frames;
        resync = false;
      }
      for (;;) {
        const id = vint(buf, pos, true);
        if (!id) break;
        const size = vint(buf, pos + id.length, false);
        if (!size) break;
        const start = pos + id.length + size.length;
        if (MASTER.has(id.value)) {
          if (id.value === 0xae || id.value === 0x1f43b675) fileEntry();
          pos = start;
          continue;
        }
        if (size.unknown) throw new Error(`WebM: element ${id.value.toString(16)} of unknown size`);
        if (start + size.value > buf.length) break;
        leaf(id.value, buf.subarray(start, start + size.value), frames);
        pos = start + size.value;
      }
      return frames;
    },
  };
}
