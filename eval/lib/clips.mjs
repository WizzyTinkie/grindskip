// The Phase 3 test set: sections of Let's Play videos of Risen, with
// speech labels from YouTube's auto-generated captions (used as they are).
// `file` is the audio in media/, `offset` where it starts in the video.
// See README.md for downloading them.
export const CLIPS = [
  {
    name: 'risen',
    video: 'BFG1Q7zpNtE',
    offset: 0,
    sec: 120,
    about: 'Morgannin, RISEN Part 1: music intro (16 s), then continuous commentary',
  },
  {
    name: 'bumpy',
    video: '4ThQDMlPWM0',
    offset: 0,
    sec: 120,
    about: 'Bumpy McSquigums, Let\'s Play Risen ep. 1: dense commentary with a quieter stretch',
  },
  {
    name: 'mattg',
    video: 'ZCC-wZjgHFo',
    offset: 90,
    sec: 120,
    about: 'AwesomeMattG, Let\'s Play Risen 001: commentary, then a minute of gameplay with little talking',
  },
  {
    name: 'nocomm',
    video: 'ZJ0hHIcMATk',
    offset: 0,
    sec: 120,
    about: 'Ishikawa Kun, Risen [No Commentary]: music, narrated intro (in-game voice), game sound',
  },
  {
    name: 'sparse',
    video: 'v4w8WzKm0Mg',
    offset: 390,
    sec: 300,
    about: 'Morgannin, Let\'s Play Risen Part 1: five minutes of gameplay with a few remarks',
  },
].map((c) => ({
  ...c,
  file: `media/${c.name}_${c.offset}-${c.offset + c.sec}.webm`,
  subs: `media/subs/${c.video}.en.json3`,
  url: `https://www.youtube.com/watch?v=${c.video}&t=${c.offset}`,
}));

// Recorded in the browsers at each of these speeds
export const SPEEDS = [1, 2, 2.5, 3, 4];

export function clip(name) {
  const c = CLIPS.find((x) => x.name === name);
  if (!c) throw new Error(`no clip ${name}`);
  return c;
}
