// Look-ahead, offline: how close to zero delay Grindskip could get if it
// analysed the audio before it plays. The 1x recordings of the Phase 3 test
// set are what look-ahead would analyse (the audio at normal speed, by media
// time), so the speech schedule comes from them: the controller run over
// the 1x probabilities with the talk-speed thresholds everywhere. Playback
// then follows the schedule, switching to talk speed `lead` media seconds
// before each onset; a speed change still reaches the audio two frames late.
// Scored like eval/run.mjs, against the same caption labels.
//
// Usage: node spikes/lookahead/replay.mjs [--play 2.5,4] [--lead 0,0.1,0.2] [--min 1,3] [--why]
import { readFileSync } from 'node:fs';
import { FRAME_SEC, PARAMS } from '../../src/controller/controller.js';
import { DEFAULTS } from '../../src/shared/settings.js';
import { createSchedule } from '../../src/lookahead/schedule.js';
import { createTimeline } from '../../src/lookahead/timeline.js';
import { CLIPS } from '../../eval/lib/clips.mjs';
import { labelsFor } from '../../eval/lib/labels.mjs';
import { combine, score, simulate, source } from '../../eval/lib/simulate.js';

const EVAL = new URL('../../eval/', import.meta.url);
const args = process.argv.slice(2);
const opt = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : d;
};
const plays = opt('--play', '2.5,4').split(',').map(Number);
const leads = opt('--lead', '0,0.1,0.2,0.3').split(',').map(Number);
const minFrames = opt('--min', '1').split(',').map(Number);
const browsers = ['chrome', 'firefox'];

function load(browser, clip, speed) {
  const rec = JSON.parse(readFileSync(new URL(`recordings/${browser}/${clip}-${speed}x.json`, EVAL), 'utf8'));
  const f = rec.frames;
  const keep = f.p.map((x, k) => x !== null && f.rate[k] === speed && f.mediaTime[k] !== null);
  return source(Float64Array.from(f.mediaTime.filter((_, k) => keep[k])), Float32Array.from(f.p.filter((_, k) => keep[k])));
}

// Media intervals to play at talk speed: speech and the wait after it, by
// the controller's rules on the 1x audio (start 0.5, end 0.35, the wait),
// except that speech needs minFrames frames in a row and then starts at the
// first of them: knowing the audio in advance, a longer minimum costs no
// delay
function schedule(one, settings, minFrames = 1) {
  const start = PARAMS.startLow - settings.sensitivity * PARAMS.sensitivityStep;
  const waitFrames = Math.round(settings.waitSec / FRAME_SEC);
  const talk = [];
  let state = 'wait';
  let from = one.media[0] - FRAME_SEC;
  let run = 0;
  let waited = 0;
  for (let k = 0; k < one.media.length; k++) {
    const p = one.p[k];
    const frameStart = one.media[k] - FRAME_SEC;
    if (state === 'gameplay') {
      run = p >= start ? run + 1 : 0;
      if (run >= minFrames) {
        state = 'speech';
        from = one.media[k - run + 1] - FRAME_SEC;
      }
    } else if (state === 'speech') {
      if (p < PARAMS.end) {
        state = 'wait';
        waited = 0;
      }
    } else if (p >= start) {
      state = 'speech';
    } else if (++waited >= waitFrames) {
      state = 'gameplay';
      run = 0;
      talk.push([from, frameStart]);
    }
  }
  if (state !== 'gameplay') talk.push([from, one.media.at(-1)]);
  return talk;
}

// Plays the clip following the schedule; the same frame format as
// simulate() in eval/lib/simulate.js
function play(talk, settings, lead, { start, end }, lagFrames = 2) {
  const frames = [];
  const isTalk = (m) => talk.some(([a, b]) => m + lead >= a && m < b);
  let media = start;
  let playing = settings.talkSpeed;
  let pending = null;
  while (media <= end) {
    const want = isTalk(media) ? settings.talkSpeed : settings.playSpeed;
    frames.push({ media, speed: playing, state: want === settings.talkSpeed ? 'speech' : 'gameplay', rewindTo: null });
    media += FRAME_SEC * playing;
    if (want !== (pending?.speed ?? playing)) pending = { speed: want, in: lagFrames };
    if (pending && pending.in-- <= 0) {
      playing = pending.speed;
      pending = null;
    }
  }
  return frames;
}

// The extension's scheduler (src/lookahead/schedule.js) on a timeline of
// the 1x probabilities, played the same way
function playScheduled(one, settings, { start, end }, lagFrames = 2) {
  // Back to back from the first frame, as decoded audio would be: the
  // recording stamps all the frames of one poll with the same media time
  const tl = createTimeline();
  const first = one.media[0] - FRAME_SEC;
  for (let k = 0; k < one.media.length; k++) tl.set(first + k * FRAME_SEC, one.p[k]);
  const sched = createSchedule(tl, settings);
  sched.reset(start);
  const frames = [];
  let media = start;
  let playing = settings.talkSpeed;
  let pending = null;
  let last = 'talk';
  while (media <= end) {
    // In the clip's last second the analysis can't reach far enough ahead;
    // a real video goes on, so keep the last decision there
    const at = sched.at(media) ?? (media > end - 1 ? last : 'talk');
    last = at;
    const want = at === 'gameplay' ? settings.playSpeed : settings.talkSpeed;
    frames.push({ media, speed: playing, state: want === settings.talkSpeed ? 'speech' : 'gameplay', rewindTo: null });
    media += FRAME_SEC * playing;
    if (want !== (pending?.speed ?? playing)) pending = { speed: want, in: lagFrames };
    if (pending && pending.in-- <= 0) {
      playing = pending.speed;
      pending = null;
    }
  }
  return frames;
}

const data = Object.fromEntries(browsers.map((b) => [b, Object.fromEntries(CLIPS.map((c) => [c.name, { 1: load(b, c.name, 1) }]))]));
for (const b of browsers) for (const c of CLIPS) for (const s of plays) data[b][c.name][s] = load(b, c.name, s);
const all = Object.fromEntries(CLIPS.map((c) => [c.name, labelsFor(c, EVAL)]));
// Heard in every browser's 1x recording, as eval/run.mjs --audible
const audible = Object.fromEntries(CLIPS.map((c) => [c.name, all[c.name].filter(([a, b]) => browsers.every((br) => {
  const src = data[br][c.name][1];
  return src.p.some((p, k) => p > 0.5 && src.media[k] > a && src.media[k] <= b + 0.1);
}))]));

// --why: where look-ahead slows down with no caption near (the false
// slowdowns), and how sure the 1x model is there
if (args.includes('--why')) {
  for (const b of browsers) {
    for (const c of CLIPS) {
      const one = data[b][c.name][1];
      const talk = schedule(one, { ...DEFAULTS, playSpeed: plays[0] }, minFrames[0]);
      for (const [a] of talk) {
        if (all[c.name].some(([x, y]) => y > a - 1.5 && x < a + 1)) continue;
        const near = [];
        for (let k = 0; k < one.media.length; k++) if (one.media[k] > a && one.media[k] < a + 1) near.push(one.p[k]);
        console.log(`${b} ${c.name} at ${a.toFixed(2)} s (video ${(a + c.offset).toFixed(2)} s): 1x p max ${Math.max(...near).toFixed(2)}, frames >= 0.5: ${near.filter((x) => x >= 0.5).length}`);
      }
    }
  }
  process.exit(0);
}

const pct = (x) => `${(x * 100).toFixed(1)}%`;
for (const speed of plays) {
  const settings = { ...DEFAULTS, playSpeed: speed };
  console.log(`\n### ${speed}x: speech at talk speed (all captions / heard at 1x), gameplay played fast, false slowdowns`);
  console.log('\n| controller | Chrome | Firefox |\n|---|---|---|');
  const row = (name, framesFor) => {
    const cells = browsers.map((b) => {
      const runs = CLIPS.map((c) => framesFor(b, c));
      const sa = combine(runs.map((f, i) => score(f, all[CLIPS[i].name], settings)));
      const sh = combine(runs.map((f, i) => score(f, audible[CLIPS[i].name], settings)));
      return `${pct(sa.speechAtTalkSpeed)} / ${pct(sh.speechAtTalkSpeed)}, ${pct(sa.quietAtGameplaySpeed)}, ${sa.falseSlowdowns}`;
    });
    console.log(`| ${name} | ${cells.join(' | ')} |`);
  };
  row('live (today)', (b, c) => simulate(data[b][c.name], settings, PARAMS));
  row('live, rewind on', (b, c) => simulate(data[b][c.name], { ...settings, rewind: true }, PARAMS));
  row('look-ahead, the extension\'s scheduler', (b, c) => {
    const srcs = data[b][c.name];
    return playScheduled(srcs[1], settings, { start: Math.max(srcs[1].start, srcs[speed].start), end: Math.min(srcs[1].end, srcs[speed].end) });
  });
  for (const n of minFrames) {
    for (const lead of leads) {
      row(`look-ahead, ${n} frame${n > 1 ? 's' : ''}, ${lead} s early`, (b, c) => {
        const srcs = data[b][c.name];
        const range = { start: Math.max(srcs[1].start, srcs[speed].start), end: Math.min(srcs[1].end, srcs[speed].end) };
        return play(schedule(srcs[1], settings, n), settings, lead, range);
      });
    }
  }
}
