// Silero VAD v6.2 (16 kHz export) on ONNX Runtime Web. `ort` is passed in,
// so the same code runs in the content script, in Chrome's offscreen
// document and under Node.
//
// Like the official OnnxWrapper, each 512-sample frame is fed with the last
// 64 samples of the previous frame in front of it, and the recurrent state
// is carried from frame to frame. One model can serve several streams (the
// offscreen document has one per tab), each with its own state.

export const SAMPLE_RATE = 16000;
export const FRAME = 512;          // 32 ms
const CONTEXT = 64;
const STATE_SIZE = 2 * 128;

export async function createModel(ort, modelBytes) {
  const session = await ort.InferenceSession.create(modelBytes, {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
  });
  const sr = new ort.Tensor('int64', BigInt64Array.from([BigInt(SAMPLE_RATE)]), []);
  // ONNX Runtime runs one inference at a time per session, so the streams'
  // frames take turns
  let queue = Promise.resolve();
  let released = false;

  return {
    createStream() {
      const input = new Float32Array(CONTEXT + FRAME);
      let state = null;
      let generation = 0;
      const stream = {
        // Clears the recurrent state and context, e.g. after a seek. Frames
        // still queued from before the reset come back as NaN.
        reset() {
          state = null;
          input.fill(0);
          generation++;
        },
        // Speech probability (0-1) for one frame of 512 samples at 16 kHz.
        process(frame) {
          if (released) return Promise.reject(new Error('Silero model released'));
          input.copyWithin(0, FRAME, FRAME + CONTEXT);
          input.set(frame, CONTEXT);
          const data = input.slice();
          const gen = generation;
          const run = queue.then(async () => {
            if (gen !== generation) return NaN;
            const out = await session.run({
              input: new ort.Tensor('float32', data, [1, CONTEXT + FRAME]),
              state: state ?? new ort.Tensor('float32', new Float32Array(STATE_SIZE), [2, 1, 128]),
              sr,
            });
            if (gen !== generation) return NaN;
            state = out.stateN;
            return out.output.data[0];
          });
          queue = run.catch(() => {});
          return run;
        },
      };
      return stream;
    },
    async release() {
      released = true;
      await queue;
      await session.release();
    },
  };
}
