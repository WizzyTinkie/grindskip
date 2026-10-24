// What a SourceBuffer's MIME type and bytes say about its contents, for the
// page hook (which buffers carry audio) and the analysis (which it can
// decode).
// Players label buffers loosely: Twitch and Kick put AAC in a
// 'video/mp4;codecs="mp4a.40.2"' buffer, and some of their streams have
// video and audio in one ('video/mp4;codecs="avc1.4D402A,mp4a.40.2"').

const AUDIO = /^(mp4a|opus|vorbis|flac|fLaC|mp3|\.mp3|ac-3|ec-3|alac)/i;
// What look-ahead decodes, by container
export const DECODES = { webm: /^opus$/i, mp4: /^(mp4a\.40\.\d+|opus)$/i };

// The codecs parameter's entries; [] if there's none
export function codecsOf(mime) {
  const m = /codecs\s*=\s*"?([^";]*)/i.exec(String(mime));
  return m ? m[1].split(',').map((c) => c.trim()).filter(Boolean) : [];
}

// Whether the buffer carries audio: an audio/ type, or an audio codec
// among its codecs
export function hasAudio(mime) {
  return /^\s*audio\//i.test(String(mime)) || codecsOf(mime).some((c) => AUDIO.test(c));
}

// Whether bytes start with an EBML header: a WebM init segment
export function isWebm(b) {
  return b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3;
}

// Whether look-ahead can decode the buffer's audio (given WebCodecs): every
// audio codec in it is one it decodes. Video alongside is skipped.
export function decodable(mime) {
  const m = /^\s*(?:audio|video)\/(webm|mp4)\b/i.exec(String(mime));
  const audio = codecsOf(mime).filter((c) => AUDIO.test(c) || /^\s*audio\//i.test(String(mime)));
  return !!m && audio.length > 0 && audio.every((c) => DECODES[m[1].toLowerCase()].test(c));
}
