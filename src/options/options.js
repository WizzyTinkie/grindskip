// The options page (the add-on's preferences in the browser): settings that
// don't belong in the popup. Saved straight to storage, like the popup's.
import { load, save, watch } from '../shared/settings.js';

const api = globalThis.browser ?? globalThis.chrome;
const debug = document.getElementById('debug');

// On what's stored now: the popup may have changed something since
debug.addEventListener('change', async () => {
  save(api.storage, { ...await load(api.storage), debug: debug.checked });
});

load(api.storage).then((s) => { debug.checked = s.debug; });
watch(api.storage, (s) => { debug.checked = s.debug; });
