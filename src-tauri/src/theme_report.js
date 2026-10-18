// Run in the content view on every page it shows (an initialization script, before the page's
// own scripts). It reports the theme the page is in -- the server sets `data-theme` and
// `data-base` on <html> (base.html, then app.js:applyTheme when the reader switches) -- so the
// app can paint the frame and the title bar in the same look.
//
// The report is a navigation to `llembas-theme:<base>`, which the app's navigation handler
// (lib.rs:allowed) reads and refuses, so nothing loads and the page is not left. That is the
// whole channel: the server's pages get no IPC, and this gives them none -- a page can say one
// of two theme names, and nothing else. The base, not the theme's id: a custom theme on the
// server is a handful of colours over `moria` or `shire`, and the base is the look the app has.
(function () {
  "use strict";
  // Only the server's pages: the app's own first-run page is painted from the app's side.
  if (window.top !== window) return;
  if (location.protocol !== "http:" && location.protocol !== "https:") return;
  if (location.hostname === "tauri.localhost") return;

  var last = "";
  function report() {
    var root = document.documentElement;
    if (!root) return;
    var base = root.getAttribute("data-base") || root.getAttribute("data-theme") || "";
    if (base !== "moria" && base !== "shire") return;
    if (base === last) return;
    last = base;
    try {
      location.assign("llembas-theme:" + base);
    } catch (e) { /* refused, as intended */ }
  }
  function watch() {
    var root = document.documentElement;
    if (!root) return;
    new MutationObserver(report).observe(root, {
      attributes: true,
      attributeFilter: ["data-theme", "data-base"]
    });
    report();
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", watch);
  } else {
    watch();
  }
})();
