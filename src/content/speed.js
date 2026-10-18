// Sets a video's playback speed, and steps aside when someone else changes
// it: the user in the player's menu, or another extension.

// A product limit rather than a browser one: speech at 4x is barely
// intelligible, and sped-up game sound is mistaken for speech more often.
export const MAX_RATE = 4;
const MIN_RATE = 0.25;
// After a new source loads, players set their own speed (YouTube restores
// the one chosen in its menu); changes in this window aren't the user's.
const LOAD_GRACE_MS = 1500;

// onOverride(rate) is called when someone else sets the speed. From then on
// set() does nothing until resume().
export function controlSpeed(video, onOverride) {
  let ours = null;          // the last rate set here
  let overridden = false;
  let graceUntil = 0;

  const onRateChange = () => {
    if (overridden || ours === null) return;
    if (Math.abs(video.playbackRate - ours) < 0.005) return;
    if (performance.now() < graceUntil) {
      video.playbackRate = ours;
      return;
    }
    overridden = true;
    onOverride?.(video.playbackRate);
  };
  const onLoadStart = () => {
    graceUntil = performance.now() + LOAD_GRACE_MS;
  };
  video.addEventListener('ratechange', onRateChange);
  video.addEventListener('loadstart', onLoadStart);

  return {
    get overridden() { return overridden; },
    set(rate) {
      if (overridden) return;
      const r = Math.round(Math.min(MAX_RATE, Math.max(MIN_RATE, rate)) * 100) / 100;
      ours = r;
      if (video.playbackRate !== r) video.playbackRate = r;
    },
    resume() {
      overridden = false;
      ours = null;
    },
    // Back to normal speed, unless someone else has set it since.
    restore() {
      if (!overridden && ours !== null && video.playbackRate !== 1) video.playbackRate = 1;
      ours = null;
    },
    stop() {
      video.removeEventListener('ratechange', onRateChange);
      video.removeEventListener('loadstart', onLoadStart);
    },
  };
}
