// Streaming resampler to 16 kHz plus 512-sample framing.
//
// Windowed-sinc interpolation with the cut-off just below the output's
// Nyquist frequency, so it low-passes and resamples in one step and works
// for any input rate (48 kHz in practice, 44.1 kHz on some machines).

const HALF_TAPS = 32;      // taps either side of the output position
const PHASES = 256;        // filter table resolution between input samples

export function createResampler(inRate, outRate = 16000) {
  const step = inRate / outRate;
  const cutoff = 0.9 * Math.min(1, outRate / inRate); // fraction of input Nyquist
  const taps = 2 * HALF_TAPS;

  // table[p * taps + k]: weight of input sample (i - HALF_TAPS + 1 + k) for
  // an output at position i + p / PHASES
  const table = new Float32Array((PHASES + 1) * taps);
  for (let p = 0; p <= PHASES; p++) {
    let sum = 0;
    for (let k = 0; k < taps; k++) {
      const x = k - HALF_TAPS + 1 - p / PHASES;
      const sinc = x === 0 ? 1 : Math.sin(Math.PI * cutoff * x) / (Math.PI * cutoff * x);
      const w = 0.42 + 0.5 * Math.cos(Math.PI * x / HALF_TAPS) + 0.08 * Math.cos(2 * Math.PI * x / HALF_TAPS);
      const v = Math.abs(x) >= HALF_TAPS ? 0 : sinc * w;
      table[p * taps + k] = v;
      sum += v;
    }
    for (let k = 0; k < taps; k++) table[p * taps + k] /= sum;
  }

  // Input history: enough for the filter span plus one push of new samples
  let hist = new Float32Array(4096);
  let histLen = HALF_TAPS - 1; // zero padding before the first sample
  let pos = HALF_TAPS - 1;     // next output position, in hist samples

  return {
    // Appends input samples and returns the 16 kHz samples they complete.
    push(samples) {
      if (histLen + samples.length > hist.length) {
        const bigger = new Float32Array(2 * (histLen + samples.length));
        bigger.set(hist.subarray(0, histLen));
        hist = bigger;
      }
      hist.set(samples, histLen);
      histLen += samples.length;

      const out = [];
      while (pos + HALF_TAPS < histLen) {
        const i = Math.floor(pos);
        const p = Math.round((pos - i) * PHASES);
        const base = i - HALF_TAPS + 1;
        const t = p * taps;
        let acc = 0;
        for (let k = 0; k < taps; k++) acc += hist[base + k] * table[t + k];
        out.push(acc);
        pos += step;
      }
      // Drop history the next output no longer needs
      const keep = Math.floor(pos) - HALF_TAPS + 1;
      if (keep > 0) {
        hist.copyWithin(0, keep, histLen);
        histLen -= keep;
        pos -= keep;
      }
      return out;
    },
    reset() {
      hist.fill(0);
      histLen = HALF_TAPS - 1;
      pos = HALF_TAPS - 1;
    },
  };
}

// Collects samples into fixed-size frames.
export function createFramer(size = 512) {
  const frame = new Float32Array(size);
  let fill = 0;
  return {
    // Calls onFrame(frame) for every completed frame. The frame is reused.
    push(samples, onFrame) {
      for (let i = 0; i < samples.length; i++) {
        frame[fill++] = samples[i];
        if (fill === size) {
          onFrame(frame);
          fill = 0;
        }
      }
    },
    reset() { fill = 0; },
  };
}
