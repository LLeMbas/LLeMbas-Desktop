// Source in the viewer: CodeMirror, read-only, from the server's own vendored build (ui/vendor,
// copied and pinned by scripts/fetch-vendor.sh). The look is the server's editor's: colours from
// the theme's tokens, never CodeMirror's own. Loaded the first time a file is shown.

let cm = null

async function load() {
  if (cm) return cm
  const [state, view, language, search, commands, highlight] = await Promise.all([
    import("../vendor/cm-state.mjs"),
    import("../vendor/cm-view.mjs"),
    import("../vendor/cm-language.mjs"),
    import("../vendor/cm-search.mjs"),
    import("../vendor/cm-commands.mjs"),
    import("../vendor/lezer-highlight.mjs"),
  ])
  const { EditorView } = view
  const { HighlightStyle, syntaxHighlighting } = language
  const { tags } = highlight
  // As the server's static/js/editor.js has them.
  const look = EditorView.theme({
    "&": { color: "var(--ink)", backgroundColor: "var(--code-bg)", fontSize: "var(--text-sm)", height: "100%" },
    ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "var(--leading-normal)" },
    ".cm-content": { caretColor: "var(--accent)" },
    ".cm-gutters": { backgroundColor: "var(--code-bg)", color: "var(--ink-faint)", border: "none" },
    ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "var(--surface-hover)" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": { backgroundColor: "var(--selection)" },
    "&.cm-focused": { outline: "none" },
    ".cm-panels": { backgroundColor: "var(--surface)", color: "var(--ink)" },
    ".cm-searchMatch": { backgroundColor: "var(--accent-soft)" },
  })
  const colours = HighlightStyle.define([
    { tag: [tags.keyword, tags.operatorKeyword, tags.modifier], color: "var(--accent)" },
    { tag: [tags.string, tags.special(tags.string)], color: "var(--leaf)" },
    { tag: [tags.comment], color: "var(--ink-faint)", fontStyle: "italic" },
    { tag: [tags.number, tags.bool, tags.null, tags.atom], color: "var(--warning)" },
    { tag: [tags.function(tags.variableName), tags.definition(tags.variableName)], color: "var(--ink)", fontWeight: "600" },
    { tag: [tags.heading], color: "var(--accent)", fontWeight: "700" },
    { tag: [tags.link, tags.url], color: "var(--accent)", textDecoration: "underline" },
    { tag: [tags.tagName, tags.typeName, tags.className], color: "var(--accent-hover)" },
    { tag: [tags.invalid], color: "var(--danger)" },
  ])
  cm = {
    state,
    view,
    base: [
      view.lineNumbers(),
      view.highlightActiveLine(),
      view.highlightActiveLineGutter(),
      view.drawSelection(),
      view.keymap.of([...search.searchKeymap, ...commands.defaultKeymap]),
      search.highlightSelectionMatches(),
      state.EditorState.readOnly.of(true),
      view.EditorView.editable.of(false),
      view.EditorView.lineWrapping,
      look,
      syntaxHighlighting(colours),
    ],
  }
  return cm
}

/** The language support for a name as `show` gives it; nothing for one without support. */
async function language(name) {
  try {
    switch (name) {
      case "markdown":
        return (await import("../vendor/cm-lang-markdown.mjs")).markdown()
      case "python":
        return (await import("../vendor/cm-lang-python.mjs")).python()
      case "javascript":
      case "jsx":
        return (await import("../vendor/cm-lang-javascript.mjs")).javascript({ jsx: name === "jsx" })
      case "typescript":
      case "tsx":
        return (await import("../vendor/cm-lang-javascript.mjs")).javascript({ typescript: true, jsx: name === "tsx" })
      case "html":
        return (await import("../vendor/cm-lang-html.mjs")).html()
      case "css":
      case "scss":
        return (await import("../vendor/cm-lang-css.mjs")).css()
      case "json":
        return (await import("../vendor/cm-lang-json.mjs")).json()
      default:
        return []
    }
  } catch {
    return []
  }
}

/** Show `text` in `parent`, read-only, at `line` when given. Returns something to `destroy()`. */
export async function codeView(parent, text, { lang = "", line = 0 } = {}) {
  const { state, view, base } = await load()
  const ed = new view.EditorView({
    parent,
    state: state.EditorState.create({ doc: text, extensions: [base, await language(lang)] }),
  })
  if (line > 0 && line <= ed.state.doc.lines) {
    const at = ed.state.doc.line(line).from
    ed.dispatch({ selection: { anchor: at }, effects: view.EditorView.scrollIntoView(at, { y: "center" }) })
  }
  return ed
}
