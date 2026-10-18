// Only the full Chrome for Testing is needed (extensions don't load in headless shell).
module.exports = {
  chrome: { skipDownload: false },
  'chrome-headless-shell': { skipDownload: true },
  firefox: { skipDownload: true },
};
