// Messages from the popup to the content script in the active tab.

// Reply: { enabled, video, state, speed, p, start, end, overridden, note }
export const STATUS = 'grindskip:status';
// Lets Grindskip change the speed again after the user changed it by hand.
export const RESUME = 'grindskip:resume';
