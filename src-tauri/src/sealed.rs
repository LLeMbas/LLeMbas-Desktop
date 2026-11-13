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

/// The policy a page of an answer is served under -- the server's `sealed.page_policy()`, minus
/// `frame-ancestors`, which would have to name the app's own scheme. Nothing runs and nothing is
/// asked for: the document is static, and this holds it to that.
pub const PAGE_POLICY: &str = "sandbox; default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src 'none'; connect-src 'none'; worker-src 'none'; child-src 'none'; frame-src 'none'; object-src 'none'; manifest-src 'none'; form-action 'none'; base-uri 'none'; webrtc 'block'";

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
        while pages.len() >= KEEP_PAGES {
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
        assert!(!csp.contains("allow-") && !csp.contains("unsafe-eval"));
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
