// Measures how long a speed change takes to take effect: from setting
// playbackRate until the video's position advances at the new rate. That's
// the time look-ahead has to slow down before speech by. It depends on the
// browser and the output device: 10-75 ms on a virtual sink (Phase 0),
// around 300 ms in Chrome on real hardware (the old project), more over
// Bluetooth.
//
// After a change, the position follows the old rate until the switch and
// the new rate after it. A line at the new rate is fitted to the positions
// seen from SETTLE_SEC to FIT_SEC after the change; where it meets the line
// at the old rate from the change is the switch. Pure: the caller passes
// wall times (performance.now() / 1000) and positions.

const SETTLE_SEC = 0.5;     // the switch is over by then, even over Bluetooth
const FIT_SEC = 1.2;
const MIN_SAMPLES = 8;
const MAX_RESIDUAL_SEC = 0.04;
const KEEP = 5;             // the last few measurements; the estimate is their maximum
const MAX_LAG_SEC = 1;

// onMeasure(seconds) is called with each new measurement
export function createLagMeter(onMeasure) {
  let change = null;        // { wall, media, from, to, samples }
  const lags = [];

  function finish() {
    const { wall: w0, media: m0, from: r0, to: r1, samples } = change;
    change = null;
    if (samples.length < MIN_SAMPLES) return;
    // The line at the new rate through the samples: m = a + r1 * w
    const a = samples.reduce((s, [w, m]) => s + m - r1 * w, 0) / samples.length;
    if (samples.some(([w, m]) => Math.abs(m - (a + r1 * w)) > MAX_RESIDUAL_SEC)) return;
    // ...meets m = m0 + r0 * (w - w0)
    const lag = (a - m0 + r0 * w0) / (r0 - r1) - w0;
    // A little below zero is measurement noise
    if (!(lag >= -0.05 && lag <= MAX_LAG_SEC)) return;
    lags.push(Math.max(0, lag));
    if (lags.length > KEEP) lags.shift();
    onMeasure?.(Math.max(0, lag));
  }

  return {
    // The rate was just set from `from` to `to`, at wall time `wall` with
    // the video at `media`
    changed(wall, media, from, to) {
      change = Math.abs(from - to) > 0.1 ? { wall, media, from, to, samples: [] } : null;
    },
    // The video's position while it plays; a seek or a pause in between
    // spoils the measurement (call reset())
    sample(wall, media) {
      if (!change) return;
      const dt = wall - change.wall;
      if (dt >= SETTLE_SEC && dt <= FIT_SEC) change.samples.push([wall, media]);
      if (dt > FIT_SEC) finish();
    },
    reset() { change = null; },
    // A measurement from before (the last page), until new ones push it out
    seed(seconds) {
      if (Number.isFinite(seconds) && seconds >= 0 && seconds <= MAX_LAG_SEC && !lags.length) lags.push(seconds);
    },
    // Seconds; null until something was measured
    get estimate() { return lags.length ? Math.max(...lags) : null; },
    get last() { return lags.at(-1) ?? null; },
  };
}
