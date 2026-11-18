//! What the viewer draws and plays: a picture, sound or video from the person's files on the
//! server or from a folder of the agent's on this computer, served to the app's own page on a
//! scheme of its own.
//!
//! A player has to be given an address: it asks for the file a piece at a time (`Range`), and
//! seeking is asking for another piece. The page may not make requests of its own and never
//! holds the token, so the address is this scheme's -- `llembas-media://localhost/<ticket>` --
//! and it is Rust that asks the server, with the token, for exactly the piece the player wanted
//! (`/api/v2/files/raw?inline=1`, which answers ranges), or reads it from the disk after checking
//! the path against the agent's folders again. A ticket is a random name for one file the page
//! was allowed to open (`media_open`); it says nothing of where the file is, opens nothing else,
//! and is forgotten when the viewer closes, when the oldest of `KEEP` gives way, and with the
//! sign-in.
//!
//! What is served is only ever something a webview decodes and never runs: a raster picture,
//! sound, video -- by the type the server found in the file's own bytes, or `kinds::detect` for
//! a local file -- and an SVG as `image/svg+xml`, which the page puts in an `<img>` and nowhere
//! else. Every answer is sandboxed by its own policy all the same, so an address opened as a
//! document could still run nothing.

use std::collections::VecDeque;
use std::io::{Read, Seek, SeekFrom};
use std::sync::Mutex;

use tauri::http::Response;

use crate::server::{self, ApiError};
use crate::{files, python};

pub const SCHEME: &str = "llembas-media";
/// How many files may be open to the page at once.
const KEEP: usize = 32;
/// The most answered to one ranged request: a player asks again for what follows.
pub const PIECE: u64 = 2 * 1024 * 1024;
/// The most answered to a request for the whole of a file (a picture; a player's fallback).
pub const WHOLE: u64 = 64 * 1024 * 1024;
/// The policy every answer carries: nothing in it may run or load anything.
pub const POLICY: &str = "sandbox; default-src 'none'; style-src 'unsafe-inline'";

/// The pictures a webview draws, by the type they are served as.
const PICTURES: [&str; 5] = [
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "image/avif",
];

/// What the page will draw the file as; it decides what type may be served.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Shown {
    Image,
    Svg,
    Sound,
}

impl Shown {
    pub fn parse(word: &str) -> Option<Shown> {
        match word {
            "image" => Some(Shown::Image),
            "svg" => Some(Shown::Svg),
            "audio" | "video" => Some(Shown::Sound),
            _ => None,
        }
    }

    /// The type to serve a file of type `found` under, or None when it is not what was asked for.
    fn serve(self, found: &str) -> Option<String> {
        let plain = found
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "/-+.".contains(c));
        match self {
            Shown::Image => PICTURES.contains(&found).then(|| found.to_string()),
            // The server hands an SVG out as a download of no type; a local one is known by
            // `kinds::detect`. Either way it is served as the image it is drawn as.
            Shown::Svg => Some("image/svg+xml".to_string()),
            Shown::Sound => ((found.starts_with("audio/") || found.starts_with("video/")) && plain)
                .then(|| found.to_string()),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum Source {
    /// A file of the server's tree: its `/files/raw?…&inline=1` on the app's door.
    Server { raw: String },
    /// A file in a folder of the agent's: the folder and the path inside it, checked on every read.
    Local { root: String, path: String },
}

#[derive(Default)]
pub struct Tickets {
    next: Mutex<u64>,
    held: Mutex<VecDeque<(String, Source, Shown)>>,
}

impl Tickets {
    /// Hold a file for the page; the ticket it is served under.
    pub fn hold(&self, source: Source, shown: Shown) -> String {
        let n = {
            let mut n = self.next.lock().unwrap();
            *n += 1;
            *n
        };
        // Not a count: a name nothing else in the window could work out.
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let salt = &n as *const u64 as usize;
        let seed = format!("{n}:{nanos}:{}:{salt}:{source:?}", std::process::id());
        let id = python::sha256_hex(seed.as_bytes())[..32].to_string();
        let mut held = self.held.lock().unwrap();
        while held.len() >= KEEP {
            held.pop_front();
        }
        held.push_back((id.clone(), source, shown));
        id
    }

    pub fn get(&self, id: &str) -> Option<(Source, Shown)> {
        self.held
            .lock()
            .unwrap()
            .iter()
            .find(|(i, _, _)| i == id)
            .map(|(_, s, k)| (s.clone(), *k))
    }

    pub fn forget(&self, id: &str) {
        self.held.lock().unwrap().retain(|(i, _, _)| i != id);
    }

    /// Every file is let go (another account, another server).
    pub fn clear(&self) {
        self.held.lock().unwrap().clear();
    }
}

/// Where a held file is served: the address form differs by platform, as Tauri's own does.
pub fn url(id: &str) -> String {
    if cfg!(windows) {
        format!("http://{SCHEME}.localhost/{id}")
    } else {
        format!("{SCHEME}://localhost/{id}")
    }
}

/// The ticket in an address this module made, or None for any other.
pub fn id_of_url(url: &str) -> Option<&str> {
    let rest = url
        .strip_prefix(&format!("{SCHEME}://localhost/"))
        .or_else(|| url.strip_prefix(&format!("http://{SCHEME}.localhost/")))?;
    (rest.len() == 32 && rest.chars().all(|c| c.is_ascii_hexdigit())).then_some(rest)
}

/// What a `Range` header asks for: one range, or nothing we answer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Wanted {
    /// No header: the whole file.
    Whole,
    /// `bytes=a-` or `bytes=a-b`.
    From(u64, Option<u64>),
    /// `bytes=-n`: the last n.
    Last(u64),
}

pub fn wanted(header: Option<&str>) -> Option<Wanted> {
    let Some(header) = header else {
        return Some(Wanted::Whole);
    };
    let spec = header.trim().strip_prefix("bytes=")?.trim();
    // Several ranges at once are never what a player asks, and are not answered.
    let (from, to) = spec.split_once('-')?;
    if spec.contains(',') {
        return None;
    }
    let (from, to) = (from.trim(), to.trim());
    if from.is_empty() {
        return to.parse().ok().filter(|n| *n > 0).map(Wanted::Last);
    }
    let start: u64 = from.parse().ok()?;
    if to.is_empty() {
        return Some(Wanted::From(start, None));
    }
    let end: u64 = to.parse().ok()?;
    (end >= start).then_some(Wanted::From(start, Some(end)))
}

/// The header that asks the server for `wanted`, never for more than a piece.
pub fn piece(wanted: Wanted) -> Option<String> {
    match wanted {
        Wanted::Whole => None,
        Wanted::From(start, end) => {
            let most = start.saturating_add(PIECE - 1);
            Some(format!(
                "bytes={start}-{}",
                end.map_or(most, |e| e.min(most))
            ))
        }
        Wanted::Last(n) => Some(format!("bytes=-{}", n.min(PIECE))),
    }
}

/// The piece of a file `len` long that `wanted` names: its first and last byte, or None when
/// there is no such piece (416).
pub fn span(wanted: Wanted, len: u64) -> Option<(u64, u64)> {
    if len == 0 {
        return None;
    }
    match wanted {
        Wanted::Whole => Some((0, len - 1)),
        Wanted::From(start, end) => (start < len).then(|| {
            let last = end.unwrap_or(len - 1).min(len - 1);
            (start, last.min(start.saturating_add(PIECE - 1)))
        }),
        Wanted::Last(n) => {
            let n = n.min(len).min(PIECE);
            Some((len - n, len - 1))
        }
    }
}

struct Answer {
    status: u16,
    kind: String,
    range: Option<String>,
    bytes: Vec<u8>,
}

fn refused(status: u16) -> Answer {
    Answer {
        status,
        kind: String::new(),
        range: None,
        bytes: Vec::new(),
    }
}

fn from_server(door: Option<(String, String)>, raw: &str, shown: Shown, wanted: Wanted) -> Answer {
    let Some((app, token)) = door else {
        return refused(401);
    };
    let limit = if wanted == Wanted::Whole {
        WHOLE
    } else {
        PIECE
    };
    match server::raw_part(&app, &token, raw, piece(wanted).as_deref(), limit) {
        Ok(part) => match shown.serve(&part.kind) {
            Some(kind) => Answer {
                status: if part.status == 206 { 206 } else { 200 },
                kind,
                range: part.range.filter(|_| part.status == 206),
                bytes: part.bytes,
            },
            None => refused(415),
        },
        Err(ApiError { status, .. }) => refused(if status == 0 { 502 } else { status }),
    }
}

fn from_disk(roots: &[String], root: &str, path: &str, shown: Shown, wanted: Wanted) -> Answer {
    let Ok((file, kind, len)) = files::media(roots, root, path) else {
        return refused(404);
    };
    if shown == Shown::Svg && kind.kind != "svg" {
        return refused(415);
    }
    let Some(served) = shown.serve(kind.mime) else {
        return refused(415);
    };
    if wanted == Wanted::Whole && len > WHOLE {
        return refused(413);
    }
    if wanted == Wanted::Whole && len == 0 {
        return Answer {
            status: 200,
            kind: served,
            range: None,
            bytes: Vec::new(),
        };
    }
    let Some((first, last)) = span(wanted, len) else {
        return Answer {
            range: Some(format!("bytes */{len}")),
            ..refused(416)
        };
    };
    let mut bytes = Vec::with_capacity((last - first + 1) as usize);
    let read = std::fs::File::open(&file).and_then(|mut f| {
        f.seek(SeekFrom::Start(first))?;
        f.take(last - first + 1).read_to_end(&mut bytes)
    });
    if read.is_err() {
        return refused(404);
    }
    let partial = wanted != Wanted::Whole;
    Answer {
        status: if partial { 206 } else { 200 },
        kind: served,
        range: partial.then(|| format!("bytes {first}-{last}/{len}")),
        bytes,
    }
}

/// The response for a request to the scheme: `path` of its address, its `Range` header, the
/// app's door when it is signed in, and the agent's folders as they are now.
pub fn respond(
    tickets: &Tickets,
    door: Option<(String, String)>,
    roots: &[String],
    path: &str,
    range: Option<&str>,
) -> Response<Vec<u8>> {
    let id = path.trim_start_matches('/');
    let answer = match (tickets.get(id), wanted(range)) {
        (None, _) => refused(404),
        (_, None) => refused(416),
        (Some((Source::Server { raw }, shown)), Some(w)) => from_server(door, &raw, shown, w),
        (Some((Source::Local { root, path }, shown)), Some(w)) => {
            from_disk(roots, &root, &path, shown, w)
        }
    };
    let mut builder = Response::builder()
        .status(answer.status)
        .header("Content-Security-Policy", POLICY)
        .header("X-Content-Type-Options", "nosniff")
        .header("Referrer-Policy", "no-referrer")
        .header("Cache-Control", "no-store")
        .header("Accept-Ranges", "bytes")
        .header("Content-Length", answer.bytes.len().to_string());
    if !answer.kind.is_empty() {
        builder = builder.header("Content-Type", answer.kind.as_str());
    }
    if let Some(range) = &answer.range {
        builder = builder.header("Content-Range", range.as_str());
    }
    builder
        .body(answer.bytes)
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_range_is_one_piece_and_never_more() {
        assert_eq!(wanted(None), Some(Wanted::Whole));
        assert_eq!(wanted(Some("bytes=0-")), Some(Wanted::From(0, None)));
        assert_eq!(
            wanted(Some("bytes=100-199")),
            Some(Wanted::From(100, Some(199)))
        );
        assert_eq!(wanted(Some(" bytes=-500 ")), Some(Wanted::Last(500)));
        for bad in [
            "bytes=5-2",
            "bytes=0-1,5-9",
            "items=0-5",
            "bytes=a-b",
            "bytes=-0",
            "bytes=",
            "bytes=-",
        ] {
            assert_eq!(wanted(Some(bad)), None, "{bad}");
        }
        // To the server: what was asked, cut to a piece.
        assert_eq!(piece(Wanted::Whole), None);
        assert_eq!(
            piece(Wanted::From(0, None)).unwrap(),
            format!("bytes=0-{}", PIECE - 1)
        );
        assert_eq!(piece(Wanted::From(10, Some(19))).unwrap(), "bytes=10-19");
        assert_eq!(
            piece(Wanted::From(10, Some(u64::MAX))).unwrap(),
            format!("bytes=10-{}", PIECE + 9)
        );
        assert_eq!(
            piece(Wanted::Last(u64::MAX)).unwrap(),
            format!("bytes=-{PIECE}")
        );
        // On disk: inside the file, and a seek past its end is no piece at all.
        assert_eq!(span(Wanted::From(0, None), 10), Some((0, 9)));
        assert_eq!(span(Wanted::From(4, Some(100)), 10), Some((4, 9)));
        assert_eq!(span(Wanted::From(10, None), 10), None);
        assert_eq!(span(Wanted::Last(3), 10), Some((7, 9)));
        assert_eq!(span(Wanted::Last(30), 10), Some((0, 9)));
        assert_eq!(span(Wanted::From(0, None), PIECE * 3), Some((0, PIECE - 1)));
        assert_eq!(span(Wanted::Whole, 0), None);
    }

    #[test]
    fn only_what_a_webview_decodes_is_served() {
        assert_eq!(
            Shown::Image.serve("image/png").as_deref(),
            Some("image/png")
        );
        assert_eq!(Shown::Image.serve("image/svg+xml"), None);
        assert_eq!(Shown::Image.serve("text/html"), None);
        assert_eq!(Shown::Image.serve("application/octet-stream"), None);
        assert_eq!(
            Shown::Sound.serve("video/mp4").as_deref(),
            Some("video/mp4")
        );
        assert_eq!(
            Shown::Sound.serve("audio/ogg").as_deref(),
            Some("audio/ogg")
        );
        assert_eq!(Shown::Sound.serve("text/html"), None);
        assert_eq!(Shown::Sound.serve("audio/x\r\nx-evil: 1"), None);
        // An SVG is an image whatever it was handed out as; the page draws it in an <img> only.
        assert_eq!(
            Shown::Svg.serve("application/octet-stream").as_deref(),
            Some("image/svg+xml")
        );
        assert_eq!(Shown::parse("video"), Some(Shown::Sound));
        assert_eq!(Shown::parse("html"), None);
        assert_eq!(Shown::parse("pdf"), None);
    }

    #[test]
    fn a_ticket_names_one_file_and_is_forgotten() {
        let tickets = Tickets::default();
        let source = Source::Server {
            raw: "/files/raw?path=%2Fa.png&inline=1".into(),
        };
        let id = tickets.hold(source.clone(), Shown::Image);
        let other = tickets.hold(source.clone(), Shown::Image);
        assert_eq!(id.len(), 32);
        assert_ne!(id, other, "the same file twice is two tickets");
        assert_eq!(tickets.get(&id), Some((source.clone(), Shown::Image)));
        assert_eq!(id_of_url(&url(&id)), Some(id.as_str()));
        assert_eq!(id_of_url("https://example.org/x"), None);
        assert_eq!(id_of_url(&format!("{SCHEME}://localhost/../{id}")), None);
        tickets.forget(&id);
        assert_eq!(tickets.get(&id), None);
        for _ in 0..KEEP {
            tickets.hold(source.clone(), Shown::Image);
        }
        assert_eq!(tickets.get(&other), None, "the oldest gives way");
        tickets.clear();
        assert_eq!(tickets.held.lock().unwrap().len(), 0);
    }

    #[test]
    fn a_local_file_is_served_in_pieces_from_inside_the_agents_folders() {
        let d = std::env::temp_dir().join(format!("llembas-media-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(d.join("project")).unwrap();
        std::fs::create_dir_all(d.join("outside")).unwrap();
        let mut png = b"\x89PNG\r\n\x1a\n".to_vec();
        png.extend_from_slice(&[7u8; 92]);
        std::fs::write(d.join("project/map.png"), &png).unwrap();
        std::fs::write(d.join("outside/map.png"), &png).unwrap();
        std::fs::write(d.join("project/page.png"), "<script>1</script>").unwrap();
        std::fs::write(
            d.join("project/draw.svg"),
            "<svg xmlns='http://www.w3.org/2000/svg'/>",
        )
        .unwrap();
        let root = d.join("project").to_string_lossy().into_owned();
        let roots = vec![root.clone()];
        let tickets = Tickets::default();
        let local = |path: &str, shown| {
            tickets.hold(
                Source::Local {
                    root: root.clone(),
                    path: path.into(),
                },
                shown,
            )
        };
        let ask = |id: &str, range: Option<&str>| {
            respond(&tickets, None, &roots, &format!("/{id}"), range)
        };
        let header = |r: &Response<Vec<u8>>, name: &str| {
            r.headers()
                .get(name)
                .and_then(|v| v.to_str().ok())
                .map(str::to_string)
        };
        let map = local("map.png", Shown::Image);
        let whole = ask(&map, None);
        assert_eq!(whole.status(), 200);
        assert_eq!(header(&whole, "content-type").as_deref(), Some("image/png"));
        assert_eq!(
            header(&whole, "content-security-policy").as_deref(),
            Some(POLICY)
        );
        assert_eq!(whole.body().len(), 100);
        let part = ask(&map, Some("bytes=8-17"));
        assert_eq!(part.status(), 206);
        assert_eq!(
            header(&part, "content-range").as_deref(),
            Some("bytes 8-17/100")
        );
        assert_eq!(part.body(), &[7u8; 10]);
        let tail = ask(&map, Some("bytes=-4"));
        assert_eq!(
            header(&tail, "content-range").as_deref(),
            Some("bytes 96-99/100")
        );
        let past = ask(&map, Some("bytes=100-"));
        assert_eq!(past.status(), 416);
        assert_eq!(
            header(&past, "content-range").as_deref(),
            Some("bytes */100")
        );
        // Words called a picture are not served as one; an SVG only as the image it is.
        assert_eq!(ask(&local("page.png", Shown::Image), None).status(), 415);
        assert_eq!(ask(&local("page.png", Shown::Svg), None).status(), 415);
        let svg = ask(&local("draw.svg", Shown::Svg), None);
        assert_eq!(
            header(&svg, "content-type").as_deref(),
            Some("image/svg+xml")
        );
        assert_eq!(ask(&local("draw.svg", Shown::Image), None).status(), 415);
        // Outside the folders, an unknown ticket, the server's file while signed out.
        assert_eq!(
            ask(&local("../outside/map.png", Shown::Image), None).status(),
            404
        );
        assert_eq!(ask("0123456789abcdef0123456789abcdef", None).status(), 404);
        assert_eq!(
            respond(&tickets, None, &[], &format!("/{map}"), None).status(),
            404
        );
        let far = tickets.hold(
            Source::Server {
                raw: "/files/raw?path=%2Fa.png&inline=1".into(),
            },
            Shown::Image,
        );
        assert_eq!(ask(&far, None).status(), 401);
        std::fs::remove_dir_all(&d).unwrap();
    }
}
