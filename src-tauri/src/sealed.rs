//! HTML to look at, sealed: an HTML file in the viewer, whether it is the agent's (`show`), the
//! server's tree's or this computer's, is a page a model may have written. It is drawn in a frame
//! from an address of its own (`llembas-sealed://`), never as part of the app's page:
//!
//! - **No bridge.** The capability names only the app's own page; Tauri gives the IPC script to
//!   the main frame only, and this scheme is not the app's origin. Nothing in the frame can call
//!   the app.
//! - **No network, no app.** It is served under the server's sealed policy (its
//!   `security/sealed.py`): `sandbox allow-scripts` without `allow-same-origin` makes it an opaque
//!   origin, nothing loads from anywhere (inline and `data:`/`blob:` only), no form is sent.
//! - **No way out.** The app refuses every navigation it did not make (see `lib.rs`), so a link or
//!   a script in the frame goes nowhere.
//!
//! The page holds the HTML until it is closed (`forget`); at most `KEEP` are kept.
//!
//! **A page in an answer** (harness spec 3.8.0, `pages.md`: a reply's `html-view` block) is
//! sealed further, and is not the app's to clean: the server rebuilds it as a static document
//! (no script, no address that leads anywhere) and the app shows those bytes as they are, under
//! `PAGE_POLICY` -- an empty `sandbox`, `script-src 'none'`: nothing in it runs. Such pages are
//! held by what they are (which reply or report, which page, in which colours), not by a
//! counter, so asking for one again gives the same address; the least recently asked for go
//! first (`KEEP_PAGES`), and one that went is simply asked for again when its place in a long
//! chat is scrolled back into view.

use std::collections::VecDeque;
use std::sync::Mutex;

pub const SCHEME: &str = "llembas-sealed";
/// The most sealed pages held at once; the oldest goes first.
const KEEP: usize = 16;

/// The policy a sealed page is served under -- the server's `sealed.policy()`, minus
/// `frame-ancestors`, which would have to name the app's own scheme.
pub const POLICY: &str = "sandbox allow-scripts allow-forms; default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' data: blob:; style-src 'unsafe-inline' data: blob:; img-src data: blob:; font-src data: blob:; media-src data: blob:; connect-src 'none'; worker-src blob:; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'";

/// The most pages of answers held at once: those on the screen are a handful, the rest are
/// fetched again when they are wanted.
const KEEP_PAGES: usize = 48;

/// The most one page of an answer may weigh; a larger one is not shown.
pub const PAGE_MAX: usize = 2 * 1024 * 1024;
/// The most all the pages of answers held may weigh together; the least recently asked for go.
const PAGES_BYTES: usize = 24 * 1024 * 1024;

/// The policy a page of an answer is served under -- the server's `sealed.page_policy()`, minus
/// `frame-ancestors`, which would have to name the app's own scheme. Nothing runs and nothing is
/// asked for: the document is static, and this holds it to that.
pub const PAGE_POLICY: &str = "sandbox; default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src 'none'; connect-src 'none'; worker-src 'none'; child-src 'none'; frame-src 'none'; object-src 'none'; manifest-src 'none'; form-action 'none'; base-uri 'none'; webrtc 'block'";

#[derive(Default)]
pub struct Pages {
    next: Mutex<u64>,
    held: Mutex<VecDeque<(String, String)>>,
    /// Pages of answers: (what it is, its id, the document), the most recently asked for last.
    pages: Mutex<VecDeque<(String, String, String)>>,
}

impl Pages {
    /// Hold `html`; the id it is served under.
    pub fn hold(&self, html: String) -> String {
        let id = {
            let mut n = self.next.lock().unwrap();
            *n += 1;
            format!("p{}", *n)
        };
        let mut held = self.held.lock().unwrap();
        while held.len() >= KEEP {
            held.pop_front();
        }
        held.push_back((id.clone(), html));
        id
    }

    /// The id of the page of an answer named by `key`, if it is held; it counts as asked for.
    pub fn page(&self, key: &str) -> Option<String> {
        let mut pages = self.pages.lock().unwrap();
        let at = pages.iter().position(|(k, _, _)| k == key)?;
        let entry = pages.remove(at)?;
        let id = entry.1.clone();
        pages.push_back(entry);
        Some(id)
    }

    /// Hold a page of an answer under `key`; the id it is served under.
    pub fn hold_page(&self, key: &str, html: String) -> String {
        if let Some(id) = self.page(key) {
            return id;
        }
        let id = {
            let mut n = self.next.lock().unwrap();
            *n += 1;
            format!("s{}", *n)
        };
        let mut pages = self.pages.lock().unwrap();
        let weight = |pages: &VecDeque<(String, String, String)>| -> usize {
            pages.iter().map(|(_, _, h)| h.len()).sum()
        };
        while !pages.is_empty()
            && (pages.len() >= KEEP_PAGES || weight(&pages) + html.len() > PAGES_BYTES)
        {
            pages.pop_front();
        }
        pages.push_back((key.to_string(), id.clone(), html));
        id
    }

    /// Every page of an answer is let go (another account, another server).
    pub fn clear_pages(&self) {
        self.pages.lock().unwrap().clear();
    }

    /// A held document and the policy it is served under.
    fn served(&self, id: &str) -> Option<(String, &'static str)> {
        if let Some(html) = self.get(id) {
            return Some((html, POLICY));
        }
        self.pages
            .lock()
            .unwrap()
            .iter()
            .find(|(_, i, _)| i == id)
            .map(|(_, _, h)| (h.clone(), PAGE_POLICY))
    }

    pub fn forget(&self, id: &str) {
        self.held.lock().unwrap().retain(|(i, _)| i != id);
    }

    pub fn get(&self, id: &str) -> Option<String> {
        self.held
            .lock()
            .unwrap()
            .iter()
            .find(|(i, _)| i == id)
            .map(|(_, h)| h.clone())
    }
}

// --- A page of an answer, looked at before it is shown ---------------------------------------
//
// The server rebuilds a page as a static document and is the one place a model's markup is
// cleaned. The app does not clean anything -- but it does not take the server's word alone
// either: before a document is held it is read as bytes for anything that could run or reach
// somewhere, and if any is found the page is not shown at all. This is a refusal, not a
// repair, and it errs on the side of refusing: a page that merely writes "javascript:" in a
// sentence is not shown. What is looked for is what the frame's policy and its empty sandbox
// would have to stop if it were there; this way it is not there.

/// `data:image/(png|jpeg|gif|webp);base64,` at the start of `s` (lower case), and how long the
/// whole inline image is (the prefix and its base64 letters).
fn data_image(s: &str) -> Option<usize> {
    let rest = s.strip_prefix("data:image/")?;
    let kind = ["png", "jpeg", "gif", "webp"]
        .into_iter()
        .find(|k| rest.starts_with(k))?;
    let rest = rest[kind.len()..].strip_prefix(";base64,")?;
    let letters = rest
        .bytes()
        .take_while(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/' | b'='))
        .count();
    Some(s.len() - rest.len() + letters)
}

/// `text` without its inline images: their base64 may hold `//`, which is no address.
fn without_images(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find("data:image/") {
        out.push_str(&rest[..at]);
        match data_image(&rest[at..]) {
            Some(n) => rest = &rest[at + n..],
            None => {
                out.push_str("data:image/");
                rest = &rest[at + "data:image/".len()..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// Every `url(` in `text` (lower case) names a place in the document (`#…`) or an inline image.
fn urls_stay(text: &str) -> bool {
    let mut rest = text;
    while let Some(at) = rest.find("url(") {
        let inside = rest[at + 4..].trim_start_matches([' ', '\t', '\n', '\r', '\x0c']);
        let inside = inside
            .strip_prefix('"')
            .or_else(|| inside.strip_prefix('\''))
            .unwrap_or(inside);
        if !(inside.starts_with('#') || data_image(inside).is_some()) {
            return false;
        }
        rest = &rest[at + 4..];
    }
    true
}

/// Text that is CSS (a style block, a `style` value) or any attribute's value: nothing in it
/// names an address, and nothing in it is written so that it would only become one when read
/// (an escape, a character reference).
fn value_stays(text: &str, css: bool) -> Result<(), &'static str> {
    if text.contains('\\') {
        return Err("a backslash in a style or an attribute");
    }
    let plain = without_images(text);
    if plain.contains("http:") || plain.contains("https:") || plain.contains("//") {
        return Err("an address in a style or an attribute");
    }
    let mut rest = text;
    while let Some(at) = rest.find('&') {
        let after = &rest[at..];
        let named = ["&amp;", "&quot;", "&lt;", "&gt;", "&apos;", "&nbsp;"];
        if css || !named.iter().any(|n| after.starts_with(n)) {
            return Err("a character reference in a style or an attribute");
        }
        rest = &after[1..];
    }
    Ok(())
}

/// Whether a page of an answer may be shown as it is: `Err` says what was found. See above.
pub fn page_safe(html: &str) -> Result<(), &'static str> {
    let d = html.to_ascii_lowercase();
    for (found, what) in [
        ("<script", "a script"),
        ("<link", "a link element"),
        ("<base", "a base element"),
        ("<iframe", "a frame"),
        ("<frame", "a frame"),
        ("<object", "an object"),
        ("<embed", "an embedded object"),
        ("<form", "a form"),
        ("javascript:", "a javascript: address"),
        ("@import", "a style sheet import"),
        ("image-set(", "an image set"),
    ] {
        if d.contains(found) {
            return Err(what);
        }
    }
    // One `meta`, the wrapper's own, before any other.
    const CHARSET: &str = "<meta charset=\"utf-8\">";
    if d.matches("<meta").count() > 1
        || d.find("<meta") != d.find(CHARSET).filter(|_| d.contains("<meta"))
    {
        return Err("a meta element");
    }
    if !urls_stay(&d) {
        return Err("an address in url()");
    }
    let b = d.as_bytes();
    let space = |c: u8| matches!(c, b' ' | b'\t' | b'\n' | b'\r' | 0x0c);
    let mut i = 0;
    while i < b.len() {
        if !(b[i] == b'<' && i + 1 < b.len() && b[i + 1].is_ascii_alphabetic()) {
            i += 1;
            continue;
        }
        // A tag: its name, then its attributes up to `>`.
        let mut j = i + 1;
        while j < b.len() && !space(b[j]) && b[j] != b'>' && b[j] != b'/' {
            j += 1;
        }
        let tag = &d[i + 1..j];
        loop {
            while j < b.len() && (space(b[j]) || b[j] == b'/') {
                j += 1;
            }
            if j >= b.len() {
                return Err("a tag that does not end");
            }
            if b[j] == b'>' {
                j += 1;
                break;
            }
            let start = j;
            while j < b.len() && !space(b[j]) && !matches!(b[j], b'=' | b'>' | b'/') {
                j += 1;
            }
            let name = &d[start..j];
            while j < b.len() && space(b[j]) {
                j += 1;
            }
            let mut value = "";
            if j < b.len() && b[j] == b'=' {
                j += 1;
                while j < b.len() && space(b[j]) {
                    j += 1;
                }
                if j < b.len() && (b[j] == b'"' || b[j] == b'\'') {
                    let quote = b[j];
                    let from = j + 1;
                    j = from;
                    while j < b.len() && b[j] != quote {
                        j += 1;
                    }
                    if j >= b.len() {
                        return Err("a value that does not end");
                    }
                    value = &d[from..j];
                    j += 1;
                } else {
                    let from = j;
                    while j < b.len() && !space(b[j]) && b[j] != b'>' {
                        j += 1;
                    }
                    value = &d[from..j];
                }
            }
            if name.len() > 2 && name.starts_with("on") {
                return Err("an event handler");
            }
            if name.starts_with("xmlns") {
                // A namespace's name: it is not fetched, and is one of the web's own.
                if !value.starts_with("http://www.w3.org/") || value.contains(['\\', '&']) {
                    return Err("a namespace that is not the web's own");
                }
                continue;
            }
            value_stays(value, name == "style")?;
            if matches!(
                name,
                "href"
                    | "src"
                    | "xlink:href"
                    | "srcset"
                    | "action"
                    | "formaction"
                    | "poster"
                    | "background"
                    | "data"
            ) {
                let v = value.trim();
                if !(v.starts_with('#') || data_image(v) == Some(v.len())) {
                    return Err("an address that leads out of the page");
                }
            }
        }
        if tag == "style" {
            // The sheet itself, up to where it ends.
            let end = d[j..].find("</style").map_or(b.len(), |e| j + e);
            value_stays(&d[j..end], true)?;
            j = end;
        }
        i = j;
    }
    Ok(())
}

/// Where a held page is served: the address form differs by platform, as Tauri's own does.
pub fn url(id: &str) -> String {
    if cfg!(windows) {
        format!("http://{SCHEME}.localhost/{id}")
    } else {
        format!("{SCHEME}://localhost/{id}")
    }
}

/// The id in a request's path: `/p3` -> `p3`.
pub fn id_of(path: &str) -> &str {
    path.trim_start_matches('/')
        .split(['?', '/'])
        .next()
        .unwrap_or("")
}

/// The response for a request to the scheme.
pub fn respond(pages: &Pages, path: &str) -> tauri::http::Response<Vec<u8>> {
    let found = pages.served(id_of(path));
    let builder = tauri::http::Response::builder()
        .header(
            "Content-Security-Policy",
            found.as_ref().map_or(PAGE_POLICY, |(_, policy)| *policy),
        )
        .header("X-Content-Type-Options", "nosniff")
        .header("Referrer-Policy", "no-referrer")
        .header("Cache-Control", "no-store");
    let built = match found.map(|(html, _)| html) {
        Some(html) => builder
            .status(200)
            .header("Content-Type", "text/html; charset=utf-8")
            .body(html.into_bytes()),
        None => builder
            .status(404)
            .header("Content-Type", "text/plain; charset=utf-8")
            .body(Vec::new()),
    };
    built.unwrap_or_else(|_| tauri::http::Response::new(Vec::new()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pages_are_held_by_id_and_the_oldest_goes() {
        let p = Pages::default();
        let first = p.hold("<p>one</p>".into());
        assert_eq!(p.get(&first).as_deref(), Some("<p>one</p>"));
        for i in 0..KEEP {
            p.hold(format!("<p>{i}</p>"));
        }
        assert_eq!(p.get(&first), None);
        let last = p.hold("<p>last</p>".into());
        p.forget(&last);
        assert_eq!(p.get(&last), None);
    }

    #[test]
    fn a_sealed_page_is_served_sealed() {
        let p = Pages::default();
        let id = p.hold("<script>alert(1)</script>".into());
        let res = respond(&p, &format!("/{id}"));
        assert_eq!(res.status(), 200);
        let csp = res.headers()["Content-Security-Policy"].to_str().unwrap();
        assert!(csp.starts_with("sandbox allow-scripts"));
        assert!(!csp.contains("allow-same-origin"));
        assert!(csp.contains("connect-src 'none'"));
        assert_eq!(respond(&p, "/nope").status(), 404);
        assert_eq!(id_of("/p7?x=1"), "p7");
    }

    /// The server's own rebuilt document (its fixture `page.json`), and pages like it.
    const WRAP: &str = "<!doctype html>\n<meta charset=\"utf-8\"><title>Cakes</title><style>:root{--page-bg:#101418;--page-ink:#E2E8EC;color-scheme:light dark}html{background:var(--page-bg,Canvas);color:var(--page-ink,CanvasText);font-family:system-ui,sans-serif}</style>\n";

    #[test]
    fn a_static_page_is_shown() {
        for body in [
            "<p>10 wrapped, 2 not</p>",
            "<table><tr><th scope=\"col\">Day</th></tr><tr><td style=\"color:var(--page-accent, #36c)\">12</td></tr></table>",
            "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 10 10\"><defs><linearGradient id=\"g\"><stop offset=\"0\" stop-color=\"#fff\"/></linearGradient></defs><rect width=\"10\" height=\"10\" fill=\"url(#g)\"/><text x=\"1\" y=\"5\">once = 3 &amp; on = 2</text></svg>",
            "<a href=\"#totals\">Totals</a><h2 id=\"totals\">Totals</h2><p>Tom &amp; Sam turned it on = fine; see http://example.org in the text.</p>",
            "<img alt=\"dot\" src=\"data:image/png;base64,iVBORw0KGgo//AAAA+/8=\"><div style=\"background:url('data:image/gif;base64,R0lGODlh//8=')\"></div>",
            "<style>td{border:1px solid var(--page-line,#ccc)} .a>.b{background:url(#g)}</style><details open><summary>More</summary></details>",
        ] {
            assert_eq!(page_safe(&format!("{WRAP}{body}")), Ok(()), "{body}");
        }
    }

    #[test]
    fn a_page_with_anything_that_could_run_or_reach_somewhere_is_not_shown() {
        for body in [
            // What must never be there at all.
            "<script>alert(1)</script>",
            "<SCRIPT src=x></SCRIPT>",
            "<link rel=\"dns-prefetch\" href=\"//a.example\">",
            "<base href=\"https://a.example/\">",
            "<iframe src=\"#\"></iframe>",
            "<frameset><frame></frameset>",
            "<object data=\"x\"></object>",
            "<embed src=\"x\">",
            "<form action=\"#\"><input></form>",
            "<meta http-equiv=\"refresh\" content=\"0;url=https://a.example\">",
            "<p onclick=\"x()\">a</p>",
            "<svg onload=x()></svg>",
            "<p\nONMOUSEOVER = \"x\">a</p>",
            "<a href=\"javascript:alert(1)\">a</a>",
            "<a href=\"https://a.example/\">a</a>",
            "<a href=\"//a.example/\">a</a>",
            "<a href=\"page2.html\">a</a>",
            "<img src=\"http://a.example/p.png\">",
            "<img src=\"data:image/svg+xml;base64,PHN2Zz4=\">",
            "<img src=\"data:text/html;base64,PHA+\">",
            // The style sheet's ways out, and the same written so they only become that when read.
            "<style>@import 'x.css';</style>",
            "<style>p{background:url(https://a.example/x)}</style>",
            "<style>p{background:url( \"//a.example/x\" )}</style>",
            "<style>p{background:image-set(\"https://a.example/x\" 1x)}</style>",
            "<style>p{background:u\\72l(https://a.example/x)}</style>",
            "<style>@\\69mport 'x.css';</style>",
            "<style>p{background:\\75 rl(x)}</style>",
            "<svg><style>p{background:&#117;rl(https://a.example/x)}</style></svg>",
            "<svg><style>p{background:url&lpar;x)}</style></svg>",
            "<p style=\"background:url(https://a.example/x)\">a</p>",
            "<p style=\"background:u\\72l(x)\">a</p>",
            "<p style=\"background:&#117;rl(x)\">a</p>",
            "<p style=\"background:url&lpar;x&rpar;\">a</p>",
            "<svg><rect fill=\"url(http://a.example/x)\"/></svg>",
            "<svg><rect fill=\"url(//a.example/x)\"/></svg>",
            "<svg><rect fill=\"u\\72l(x)\"/></svg>",
            "<svg><rect fill=\"url&#40;x)\"/></svg>",
            "<svg><use xlink:href=\"https://a.example/x.svg#a\"/></svg>",
            "<svg xmlns=\"http://a.example/ns\"></svg>",
            "<p style=\"background:url(x.png)\">a</p>",
            // What does not end is not guessed at.
            "<p title=\"a",
            "<p ",
        ] {
            assert!(page_safe(&format!("{WRAP}{body}")).is_err(), "{body}");
        }
        // A second meta, or one that is not the wrapper's.
        assert!(page_safe("<meta charset=\"utf-8\"><meta charset=\"utf-8\"><p>a</p>").is_err());
        assert!(page_safe("<meta name=\"referrer\" content=\"unsafe-url\"><p>a</p>").is_err());
        assert_eq!(page_safe("<p>no wrapper, nothing in it</p>"), Ok(()));
    }

    #[test]
    fn the_pages_held_are_bounded_by_what_they_weigh() {
        let p = Pages::default();
        let big = "x".repeat(PAGES_BYTES / 4);
        let first = p.hold_page("m/a/1/", big.clone());
        for i in 2..=4 {
            p.hold_page(&format!("m/a/{i}/"), big.clone());
        }
        assert_eq!(respond(&p, &format!("/{first}")).status(), 200);
        // A fifth does not fit beside the four: the least recently asked for goes.
        p.hold_page("m/a/5/", big);
        assert_eq!(respond(&p, &format!("/{first}")).status(), 404);
        assert!(p.page("m/a/5/").is_some() && p.page("m/a/2/").is_some());
    }

    #[test]
    fn a_page_of_an_answer_is_static_held_by_what_it_is_and_asked_for_again_when_it_went() {
        let p = Pages::default();
        let id = p.hold_page("m/msg1/abc/", "<p>10 wrapped</p>".into());
        assert_eq!(p.hold_page("m/msg1/abc/", "<p>other</p>".into()), id);
        let res = respond(&p, &format!("/{id}"));
        assert_eq!(res.status(), 200);
        assert_eq!(res.body(), b"<p>10 wrapped</p>");
        let csp = res.headers()["Content-Security-Policy"].to_str().unwrap();
        assert!(csp.starts_with("sandbox;"), "an empty sandbox: {csp}");
        assert!(csp.contains("script-src 'none'") && csp.contains("default-src 'none'"));
        assert!(!csp.contains("allow-") && !csp.contains("unsafe-eval") && !csp.contains("blob:"));
        assert!(!csp.contains("frame-ancestors"));
        // The least recently asked for goes first; one asked for again stays.
        for i in 0..KEEP_PAGES - 1 {
            p.hold_page(&format!("m/msg1/{i}/"), String::new());
        }
        assert_eq!(p.page("m/msg1/abc/").as_deref(), Some(id.as_str()));
        p.hold_page("m/msg1/new/", String::new());
        assert_eq!(p.page("m/msg1/abc/").as_deref(), Some(id.as_str()));
        assert_eq!(p.page("m/msg1/0/"), None, "the oldest went");
        // A viewer's page is served as before, and a page of an answer never under its policy.
        let viewer = p.hold("<p>file</p>".into());
        let v = respond(&p, &format!("/{viewer}"));
        assert!(v.headers()["Content-Security-Policy"]
            .to_str()
            .unwrap()
            .starts_with("sandbox allow-scripts"));
        p.clear_pages();
        assert_eq!(respond(&p, &format!("/{id}")).status(), 404);
    }
}
