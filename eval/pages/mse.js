// ?src=<WebM Opus file>: plays it through Media Source Extensions the way
// YouTube does, so that Grindskip's look-ahead can analyse it: the file is
// appended in 64 KB pieces, keeping about AHEAD_SEC buffered beyond the
// playing position. A seek past what's buffered starts appending again
// from the cluster before it (the clusters are found by scanning the file).
const AHEAD_SEC = 30;
const PIECE = 64 * 1024;
const video = document.getElementById('v');
const src = new URLSearchParams(location.search).get('src');

// The byte offset and time (s) of every Cluster with a Timecode, by scanning
// for its ID; good enough for the test files (1 ms TimecodeScale)
function clusters(bytes) {
  const out = [];
  for (let i = 0; i + 12 < bytes.length; i++) {
    if (bytes[i] !== 0x1f || bytes[i + 1] !== 0x43 || bytes[i + 2] !== 0xb6 || bytes[i + 3] !== 0x75) continue;
    let p = i + 4;
    let len = 1;
    while (len <= 8 && !(bytes[p] & (0x80 >> (len - 1)))) len++;
    p += len;
    if (bytes[p] !== 0xe7) continue;
    const n = bytes[p + 1] & 0x7f;
    let tc = 0;
    for (let k = 0; k < n; k++) tc = tc * 256 + bytes[p + 2 + k];
    out.push({ at: i, t: tc / 1000 });
  }
  return out;
}

const ms = new MediaSource();
video.src = URL.createObjectURL(ms);
ms.addEventListener('sourceopen', async () => {
  const bytes = new Uint8Array(await (await fetch(src)).arrayBuffer());
  const index = clusters(bytes);
  const sb = ms.addSourceBuffer('audio/webm; codecs="opus"');
  const done = () => new Promise((ok) => sb.addEventListener('updateend', ok, { once: true }));
  sb.appendBuffer(bytes.subarray(0, index[0].at));      // the init segment
  await done();
  let pos = index[0].at;
  let restartAt = null;
  video.addEventListener('seeking', () => {
    const t = video.currentTime;
    const r = sb.buffered;
    for (let i = 0; i < r.length; i++) if (t >= r.start(i) && t < r.end(i) - 1) return;
    restartAt = [...index].reverse().find((c) => c.t <= t) ?? index[0];
  });
  for (;;) {
    if (restartAt) {
      sb.abort();
      pos = restartAt.at;
      restartAt = null;
    }
    const end = sb.buffered.length ? sb.buffered.end(sb.buffered.length - 1) : 0;
    if (pos < bytes.length && end - video.currentTime < AHEAD_SEC) {
      sb.appendBuffer(bytes.subarray(pos, pos + PIECE));
      pos += PIECE;
      await done();
    } else {
      if (pos >= bytes.length && ms.readyState === 'open' && !sb.updating) ms.endOfStream();
      await new Promise((ok) => setTimeout(ok, 200));
    }
  }
});
