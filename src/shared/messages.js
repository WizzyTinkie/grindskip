// Messages from the popup to the content script in the active tab.

// Reply: { enabled, video, recording, state, speed, p, start, end,
// overridden, where, note }
export const STATUS = 'grindskip:status';
// Lets Grindskip change the speed again after the user changed it by hand.
export const RESUME = 'grindskip:resume';
// Starts a debug recording (content/recorder.js).
export const RECORD_START = 'grindskip:recordStart';
// Ends it and saves it as a file. Reply: { ok, file }
export const RECORD_STOP = 'grindskip:recordStop';
