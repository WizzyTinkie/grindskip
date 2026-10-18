// Finds the video to follow: the largest one on the page, or one that starts
// playing while the followed one isn't. Picks again when the followed video
// leaves the page, as when YouTube swaps its player.

export function largestVideo(doc) {
  let best = null;
  let bestArea = -1;
  for (const v of doc.querySelectorAll('video')) {
    const area = v.clientWidth * v.clientHeight;
    if (area > bestArea) {
      best = v;
      bestArea = area;
    }
  }
  return best;
}

// Playing and producing sound: not paused, ended, seeking or buffering.
export function isPlaying(video) {
  return !video.paused && !video.ended && !video.seeking && video.readyState >= 3;
}

// Calls onChange(video) with the video to follow (null when there is none)
// whenever that changes. Returns a function that stops tracking.
export function trackVideo(doc, onChange) {
  let current = null;
  let timer = null;

  const choose = (video) => {
    if (video === current) return;
    current = video;
    onChange(video);
  };
  const rescan = () => {
    timer = null;
    if (!current || !current.isConnected) choose(largestVideo(doc));
  };
  // DOM changes come in bursts on sites like YouTube, so rescans are batched
  const observer = new MutationObserver(() => {
    timer ??= setTimeout(rescan, 250);
  });
  observer.observe(doc.documentElement, { childList: true, subtree: true });

  // Media events don't bubble, but they can be caught on the way down
  const onPlay = (e) => {
    const v = e.target;
    if (v?.localName !== 'video' || v === current) return;
    if (!current || !current.isConnected || current.paused) choose(v);
  };
  doc.addEventListener('play', onPlay, true);

  rescan();
  return () => {
    observer.disconnect();
    clearTimeout(timer);
    doc.removeEventListener('play', onPlay, true);
    current = null;
  };
}
