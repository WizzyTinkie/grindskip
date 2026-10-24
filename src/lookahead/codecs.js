// What a SourceBuffer's MIME type says about its contents, for the page
// hook (which buffers carry audio) and the analysis (which it can decode).
// Players label buffers loosely: Twitch and Kick put AAC in a
// 'video/mp4;codecs="mp4a.40.2"' buffer.

const AUDIO = /^(mp4a|opus|vorbis|flac|fLaC|mp3|\.mp3|ac-3|ec-3|alac)/i;
// What look-ahead decodes, by container
const DECODES = { webm: /^opus$/i, mp4: /^(mp4a\.40\.\d+|opus)$/i };

// The codecs parameter's entries; [] if there's none
export function codecsOf(mime) {
  const m = /codecs\s*=\s*"?([^";]*)/i.exec(String(mime));
  return m ? m[1].split(',').map((c) => c.trim()).filter(Boolean) : [];
}

// Whether the buffer carries audio only: an audio/ type, or codecs that
// are all audio ones
export function isAudioOnly(mime) {
  const codecs = codecsOf(mime);
  if (/^\s*audio\//i.test(String(mime))) return true;
  return codecs.length > 0 && codecs.every((c) => AUDIO.test(c));
}

// Whether look-ahead can decode the buffer's audio (given WebCodecs)
export function decodable(mime) {
  const m = /^\s*(?:audio|video)\/(webm|mp4)\b/i.exec(String(mime));
  const codecs = codecsOf(mime);
  return !!m && isAudioOnly(mime) && codecs.length > 0 && codecs.every((c) => DECODES[m[1].toLowerCase()].test(c));
}
