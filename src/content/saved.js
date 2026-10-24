// Counts the time Grindskip saves on a video, compared with watching it at
// 1x: media time dm played at rate r takes dm / r, saving dm * (1 - 1/r).
// Seeks and stretches played while active() is false (the user set the
// speed) don't count.

// A step in media time longer than this between two updates isn't playback
// (a seek the events missed, a new source)
const MAX_STEP_SEC = 5;

export function countSaved(video, active = () => true) {
  let seconds = 0;          // on this video
  let unsent = 0;           // not yet handed over by take()
  let lastTime = video.currentTime;
  let rate = video.playbackRate;

  const add = (s) => {
    seconds += s;
    unsent += s;
  };
  // Counts the media played since the last update, at the rate it played at
  const update = () => {
    const t = video.currentTime;
    if (lastTime !== null) {
      const dm = t - lastTime;
      if (dm > 0 && dm < MAX_STEP_SEC && active()) add(dm * (1 - 1 / rate));
    }
    lastTime = t;
    rate = video.playbackRate;
  };
  const forget = () => {
    lastTime = null;
  };
  const events = { timeupdate: update, ratechange: update, pause: update, seeking: forget };
  for (const [name, fn] of Object.entries(events)) video.addEventListener(name, fn);

  return {
    get seconds() { return seconds; },
    get unsent() { return unsent; },
    // A new source: the count for this video starts again
    newVideo() {
      seconds = 0;
      lastTime = null;
    },
    // The seconds saved since the last take()
    take() {
      update();
      const s = unsent;
      unsent = 0;
      return s;
    },
    stop() {
      for (const [name, fn] of Object.entries(events)) video.removeEventListener(name, fn);
    },
  };
}
