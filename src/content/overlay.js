// The meter drawn over the video: the speech probability, the start and end
// thresholds, the state and the speed. Built with DOM calls only (YouTube
// enforces Trusted Types, so no innerHTML) and styled through element.style,
// which a page's CSP can't block the way it can a <style> element. It sits
// in a closed shadow root so the page's CSS doesn't reach it.

const COLORS = { speech: '#4ade80', wait: '#60a5fa', gameplay: '#f59e0b', idle: '#9ca3af' };
const LABELS = { speech: 'Talking', wait: 'Pause', gameplay: 'Gameplay', idle: 'Listening' };

function el(tag, style, parent) {
  const e = document.createElement(tag);
  Object.assign(e.style, style);
  parent?.appendChild(e);
  return e;
}

export function createOverlay() {
  const host = el('div', { all: 'initial', position: 'fixed', zIndex: '2147483647', pointerEvents: 'none' });
  const root = host.attachShadow({ mode: 'closed' });
  const box = el('div', {
    boxSizing: 'border-box',
    width: '180px',
    padding: '6px 8px',
    borderRadius: '6px',
    background: 'rgba(0, 0, 0, 0.75)',
    color: '#fff',
    font: '12px/1.35 system-ui, sans-serif',
    userSelect: 'none',
  }, root);
  const head = el('div', { display: 'flex', justifyContent: 'space-between', fontWeight: '600' }, box);
  const label = el('span', {}, head);
  const speed = el('span', { fontVariantNumeric: 'tabular-nums' }, head);
  const meter = el('div', {
    position: 'relative', height: '6px', marginTop: '4px', borderRadius: '3px', background: 'rgba(255, 255, 255, 0.2)',
  }, box);
  const bar = el('div', { position: 'absolute', left: '0', top: '0', bottom: '0', width: '0', borderRadius: '3px' }, meter);
  const tick = (color) => el('div', { position: 'absolute', top: '-2px', bottom: '-2px', width: '2px', background: color }, meter);
  const startTick = tick('#fff');
  const endTick = tick('rgba(255, 255, 255, 0.5)');
  const note = el('div', { marginTop: '4px', fontSize: '11px', color: '#d1d5db', display: 'none' }, box);

  let video = null;
  const place = () => {
    // Inside the fullscreen element, or it wouldn't show in fullscreen
    const parent = document.fullscreenElement ?? document.documentElement;
    if (host.parentNode !== parent) parent.appendChild(host);
    const r = video?.getBoundingClientRect();
    host.style.left = `${Math.max(0, r?.left ?? 0) + 8}px`;
    host.style.top = `${Math.max(0, r?.top ?? 0) + 8}px`;
  };
  document.addEventListener('fullscreenchange', place);

  return {
    // status: { video, state, speed, p, start, end, note }; any can be
    // missing while nothing has been heard yet.
    update(status) {
      video = status.video ?? null;
      const state = status.state ?? 'idle';
      label.textContent = LABELS[state];
      label.style.color = COLORS[state];
      speed.textContent = Number.isFinite(status.speed) ? `${status.speed.toFixed(2)}x` : '';
      bar.style.width = `${Math.round((status.p ?? 0) * 100)}%`;
      bar.style.background = COLORS[state];
      for (const [t, v] of [[startTick, status.start], [endTick, status.end]]) {
        t.style.display = Number.isFinite(v) ? 'block' : 'none';
        if (Number.isFinite(v)) t.style.left = `calc(${(v * 100).toFixed(1)}% - 1px)`;
      }
      note.textContent = status.note ?? '';
      note.style.display = status.note ? 'block' : 'none';
      place();
    },
    remove() {
      document.removeEventListener('fullscreenchange', place);
      host.remove();
    },
  };
}
