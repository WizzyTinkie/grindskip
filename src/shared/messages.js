// Messages from the popup to the content script in the active tab, from the
// content scripts to the background script, and from the content script to
// the page hook.

// Reply: { enabled, video, recording: { seconds, full } | null, state, speed,
// p, start, end, overridden, where, mode ('look-ahead' or 'live'), lookahead
// (the analysis's status, or null), note, saved: { video, unsent } }
export const STATUS = 'grindskip:status';
// Lets Grindskip change the speed again after the user changed it by hand.
export const RESUME = 'grindskip:resume';
// Starts a debug recording (content/recorder.js).
export const RECORD_START = 'grindskip:recordStart';
// Ends it and saves it as a file. Reply: { ok, file }
export const RECORD_STOP = 'grindskip:recordStop';

// From the content scripts to the background script: { seconds } saved
// since the last report, to add to the total (shared/stats.js).
export const ADD_SAVED = 'grindskip:addSaved';

// From the content script to the page hook, posted to the window with the
// MessagePort the look-ahead feed talks over (page/hook.js).
export const HOOK_HELLO = 'grindskip:lookahead';
