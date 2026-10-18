import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ENSURE_OFFSCREEN, PORT_NAME, createRemoteVad } from '../src/vad/remote.js';

function event() {
  const listeners = [];
  return { addListener: (l) => listeners.push(l), fire: (...a) => listeners.forEach((l) => l(...a)) };
}

// A runtime whose offscreen document answers each frame with its mean, and
// whose ports can be dropped
function fakeRuntime({ ensure = { ok: true } } = {}) {
  const rt = { ports: [], ensured: 0, sent: [] };
  rt.sendMessage = async (msg) => {
    assert.equal(msg.type, ENSURE_OFFSCREEN);
    rt.ensured++;
    return ensure;
  };
  rt.connect = ({ name }) => {
    assert.equal(name, PORT_NAME);
    const port = { onMessage: event(), onDisconnect: event(), open: true };
    port.postMessage = (m) => {
      if (!port.open) throw new Error('closed');
      rt.sent.push(m);
      if (m.frame) {
        const p = m.frame.reduce((a, b) => a + b, 0) / m.frame.length;
        queueMicrotask(() => port.open && port.onMessage.fire({ id: m.id, p: m.frame[0] < 0 ? null : p }));
      }
    };
    port.disconnect = () => { port.open = false; };
    port.drop = () => { port.open = false; port.onDisconnect.fire(); };
    rt.ports.push(port);
    return port;
  };
  return rt;
}

test('frames go out as arrays and come back as probabilities', async () => {
  const rt = fakeRuntime();
  const vad = createRemoteVad(rt);
  assert.equal(await vad.process(new Float32Array(4).fill(0.25)), 0.25);
  assert.ok(Array.isArray(rt.sent[0].frame));
  // A frame dropped by a reset comes back as null, which is NaN here
  assert.ok(Number.isNaN(await vad.process(new Float32Array(4).fill(-1))));
  vad.reset();
  assert.deepEqual(rt.sent.at(-1), { reset: true });
});

test('a dropped port fails what was pending, and the next frame reconnects', async () => {
  const rt = fakeRuntime();
  const vad = createRemoteVad(rt);
  await vad.ready();
  // Dropped while process() was waiting to send
  const late = vad.process(new Float32Array(4));
  rt.ports[0].drop();
  await assert.rejects(late, /disconnected/);
  // Dropped after sending, before the reply
  await vad.ready();
  rt.ports[1].postMessage = () => {};
  const pending = vad.process(new Float32Array(4));
  await new Promise((ok) => setTimeout(ok, 0));
  rt.ports[1].drop();
  await assert.rejects(pending, /disconnected/);
  assert.equal(await vad.process(new Float32Array(4).fill(0.5)), 0.5);
  assert.equal(rt.ports.length, 3);
  assert.equal(rt.ensured, 3);
});

test('when there is no offscreen document it fails, and waits before trying again', async () => {
  const rt = fakeRuntime({ ensure: null });
  const vad = createRemoteVad(rt);
  await assert.rejects(vad.ready());
  await assert.rejects(vad.process(new Float32Array(4)));
  assert.equal(rt.ensured, 1);
});
