// Silero VAD (v5/v6) session for 16 kHz audio, used both under Node and in
// the browser. `ort` is passed in so the caller picks the ONNX Runtime build.
//
// Like the official OnnxWrapper, each 512-sample frame is fed with the last
// 64 samples of the previous frame in front of it (576 samples), and the
// recurrent state is carried from frame to frame.

export const SAMPLE_RATE = 16000;
export const FRAME = 512;          // 32 ms
const CONTEXT = 64;

export async function createSilero(ort, modelBytes) {
  const session = await ort.InferenceSession.create(modelBytes, {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
  });
  const sr = new ort.Tensor('int64', BigInt64Array.from([BigInt(SAMPLE_RATE)]), []);
  const input = new Float32Array(CONTEXT + FRAME);
  let state = new ort.Tensor('float32', new Float32Array(2 * 128), [2, 1, 128]);

  return {
    // Clears the recurrent state and context, e.g. after a seek.
    reset() {
      state = new ort.Tensor('float32', new Float32Array(2 * 128), [2, 1, 128]);
      input.fill(0);
    },
    // Speech probability for one 512-sample frame.
    async process(frame) {
      input.copyWithin(0, FRAME, FRAME + CONTEXT);
      input.set(frame, CONTEXT);
      const out = await session.run({
        input: new ort.Tensor('float32', input.slice(), [1, CONTEXT + FRAME]),
        state,
        sr,
      });
      state = out.stateN;
      return out.output.data[0];
    },
    release() { return session.release(); },
  };
}
