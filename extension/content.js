// Asks the background worker to inject this frame's element-hiding stylesheet.
// The background injects it with insertCSS, so the page can't remove it.
chrome.runtime.sendMessage({ type: 'cosmetic' }).catch(() => {});
