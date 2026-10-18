// The app's own pages are painted in the server page's theme, which the app reports in `status`
// (see src-tauri/src/lib.rs: the content view says, the app remembers). tokens.css selects a
// theme by `data-theme` and `data-base` on <html>, as the server's pages do; with nothing set
// it is Moria, the server's own default, so the page needs no script to be right at first.
"use strict"

window.lembasTheme = {
  apply(name) {
    if (name !== "moria" && name !== "shire") return
    const root = document.documentElement
    if (root.dataset.theme === name) return
    root.dataset.theme = name
    root.dataset.base = name
  },
}
