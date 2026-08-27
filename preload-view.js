const { contextBridge, ipcRenderer } = require("electron");

// Monitor title changes in the BrowserView
const observer = new MutationObserver(() => {
  ipcRenderer.send("view-title-changed", document.title);
});

// Start observing the title tag
const titleElement = document.querySelector("title");
if (titleElement) {
  observer.observe(titleElement, { childList: true, characterData: true, subtree: true });
}

// Also observe if title tag is added/removed
const docObserver = new MutationObserver((mutations) => {
  for (const mutation of mutations) {
    if (mutation.addedNodes.length) {
      for (const node of mutation.addedNodes) {
        if (node.tagName === "TITLE") {
          observer.disconnect();
          observer.observe(node, { childList: true, characterData: true, subtree: true });
        }
      }
    }
  }
});

docObserver.observe(document.head || document.documentElement, { childList: true });

// Also send initial title when page loads
window.addEventListener("load", () => {
  setTimeout(() => {
    ipcRenderer.send("view-title-changed", document.title);
  }, 100);
});

// Ensure we catch title changes early
if (document.title) {
  ipcRenderer.send("view-title-changed", document.title);
}
