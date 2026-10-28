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

use std::collections::VecDeque;
use std::sync::Mutex;

pub const SCHEME: &str = "llembas-sealed";
/// The most sealed pages held at once; the oldest goes first.
const KEEP: usize = 16;

/// The policy a sealed page is served under -- the server's `sealed.policy()`, minus
/// `frame-ancestors`, which would have to name the app's own scheme.
pub const POLICY: &str = "sandbox allow-scripts allow-forms; default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' data: blob:; style-src 'unsafe-inline' data: blob:; img-src data: blob:; font-src data: blob:; media-src data: blob:; connect-src 'none'; worker-src blob:; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'";

#[derive(Default)]
pub struct Pages {
    next: Mutex<u64>,
    held: Mutex<VecDeque<(String, String)>>,
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
    let builder = tauri::http::Response::builder()
        .header("Content-Security-Policy", POLICY)
        .header("X-Content-Type-Options", "nosniff")
        .header("Referrer-Policy", "no-referrer")
        .header("Cache-Control", "no-store");
    let built = match pages.get(id_of(path)) {
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
}
