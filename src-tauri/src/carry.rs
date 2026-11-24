//! A file carried from one place to another -- this computer, the server, a linked computer --
//! whatever it holds: read from where it is as it comes, counted so the page can say how far it
//! is, and stopped at once when the person cancels. Where it lands on this computer it is
//! written beside its place and named only once whole (`server::save_from`), so a transfer that
//! breaks off or is cancelled leaves nothing behind; where it goes to the server or to a linked
//! computer it is read whole first and sent as one upload, which the other side takes or refuses
//! as a whole.

use std::collections::HashMap;
use std::io::Read;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::files;
use crate::server::{self, ApiError};

/// How many transfers run at once: each one bound for the server or a linked computer holds its
/// file in memory (up to the upload's limit, and as much again while it is sent).
pub const AT_ONCE: usize = 2;

/// How many bytes pass between two words to the page of how far a transfer is.
pub const STEP: u64 = 256 * 1024;

/// What a stopped read says of itself, so the end of a transfer can tell "cancelled" from "broke".
const STOPPED: &str = "the transfer was cancelled";

/// The transfers under way, each with the switch that stops it.
#[derive(Default)]
pub struct Jobs {
    stops: Mutex<HashMap<u64, Arc<AtomicBool>>>,
    next: AtomicU64,
}

impl Jobs {
    /// A new transfer: its id for the page, and its switch -- or nothing, where as many run
    /// already as may run at once.
    pub fn begin(&self) -> Option<(u64, Arc<AtomicBool>)> {
        let mut stops = self.stops.lock().unwrap();
        if stops.len() >= AT_ONCE {
            return None;
        }
        let id = self.next.fetch_add(1, Ordering::SeqCst) + 1;
        let stop = Arc::new(AtomicBool::new(false));
        stops.insert(id, stop.clone());
        Some((id, stop))
    }

    /// How many run now.
    pub fn running(&self) -> usize {
        self.stops.lock().unwrap().len()
    }

    /// Stop every one and wait -- at most `patience` -- until each has ended: what it was
    /// writing on this computer is gone by then (a transfer that ends lets go of its half-written
    /// file). Before the app goes, so that Quit leaves nothing behind. Whether all ended in time.
    pub fn wind_down(&self, patience: Duration) -> bool {
        self.cancel_all();
        let until = Instant::now() + patience;
        while self.running() > 0 {
            if Instant::now() >= until {
                return false;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        true
    }

    /// Stop one (the person's Cancel). One that has ended is nothing to stop.
    pub fn cancel(&self, id: u64) {
        if let Some(stop) = self.stops.lock().unwrap().get(&id) {
            stop.store(true, Ordering::SeqCst);
        }
    }

    pub fn end(&self, id: u64) {
        self.stops.lock().unwrap().remove(&id);
    }

    /// Stop every one (signed out, another server).
    pub fn cancel_all(&self) {
        for stop in self.stops.lock().unwrap().values() {
            stop.store(true, Ordering::SeqCst);
        }
    }
}

/// What is read, watched: every `STEP` bytes `tell` hears how many have come, and once `stop`
/// is set the next read fails -- whoever copies from it stops there.
pub struct Watched<R, F: FnMut(u64)> {
    inner: R,
    done: u64,
    said: u64,
    stop: Arc<AtomicBool>,
    tell: F,
}

impl<R: Read, F: FnMut(u64)> Watched<R, F> {
    pub fn new(inner: R, stop: Arc<AtomicBool>, tell: F) -> Self {
        Watched {
            inner,
            done: 0,
            said: 0,
            stop,
            tell,
        }
    }
}

impl<R: Read, F: FnMut(u64)> Read for Watched<R, F> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        if self.stop.load(Ordering::SeqCst) {
            return Err(std::io::Error::other(STOPPED));
        }
        let n = self.inner.read(buf)?;
        self.done += n as u64;
        if self.done - self.said >= STEP || (n == 0 && self.done != self.said) {
            self.said = self.done;
            (self.tell)(self.done);
        }
        Ok(n)
    }
}

/// One end of a transfer: a place (`local`, with the agent's folder `root`; `server`; `device`,
/// with the computer's id) and a path there -- the file itself where it comes from, the folder
/// it goes into where it lands.
#[derive(Clone, Debug, serde::Deserialize)]
pub struct Place {
    pub place: String,
    pub root: Option<String>,
    pub device: Option<String>,
    pub path: String,
}

/// What a transfer works with: the sign-in (the server's address for the app, and the token),
/// the agent's folders, and what is the CLI's own among them.
pub struct Ctx {
    pub door: Option<(String, String)>,
    pub roots: Vec<String>,
    pub kept: Vec<PathBuf>,
}

/// Carry one file from `from` to the folder `to`, under `name`. `said(state, more)` hears how it
/// goes: `reading` with `{ done, total }`, then -- bound for the server or a linked computer --
/// `sending`. The name (or path) it has where it landed.
///
/// What is too large to be sent is said before a byte of it is read or fetched, where its size
/// is known. A stop (`stop`) ends it at the next read -- while it is read and while it is sent;
/// only once the whole of an upload has gone can it no longer be taken back, and then it ends
/// as done, which is what it is.
pub fn carry_one(
    ctx: &Ctx,
    stop: &Arc<AtomicBool>,
    from: &Place,
    to: &Place,
    name: &str,
    said: &(dyn Fn(&str, Value) + Sync),
) -> Result<String, ApiError> {
    let signed = || {
        ctx.door
            .clone()
            .ok_or_else(|| ApiError::new(401, "Not signed in."))
    };
    let device_of = |p: &Place| p.device.clone().unwrap_or_default();
    let uploaded = matches!(to.place.as_str(), "server" | "device");
    if !uploaded && to.place != "local" {
        return Err(ApiError::new(400, "No such place."));
    }
    let too_large = || ApiError::new(413, "This file is too large to send.");
    // Where it comes from: opened to be read as it comes, with its length where that is known.
    let (body, total): (Box<dyn Read + Send>, Option<u64>) = match from.place.as_str() {
        "local" => {
            let root = from.root.as_deref().unwrap_or("");
            let (_, at) =
                files::resolve(&ctx.roots, root, &from.path).map_err(|e| ApiError::new(400, e))?;
            let (file, meta) = files::open_regular(&at, true)
                .map_err(|e| ApiError::new(400, format!("{}: {e}", from.path)))?;
            // (Known at once, before anything is asked of the server.)
            if uploaded && meta.len() > server::UPLOAD_LIMIT {
                return Err(too_large());
            }
            (Box::new(file) as Box<dyn Read + Send>, Some(meta.len()))
        }
        "server" => {
            let (app_url, token) = signed()?;
            let raw = server::raw_path(&from.path, None, false)?;
            let (body, length) = server::open_raw(&app_url, &token, &raw)?;
            (Box::new(body) as Box<dyn Read + Send>, length)
        }
        "device" => {
            let (app_url, token) = signed()?;
            let raw = server::device_raw_path(&device_of(from), &from.path, false)?;
            let (body, length) = server::open_raw(&app_url, &token, &raw)?;
            (Box::new(body) as Box<dyn Read + Send>, length)
        }
        _ => return Err(ApiError::new(400, "No such place.")),
    };
    // (The answer said how long it is: nothing of a body that will not be sent is fetched.)
    if uploaded && total.is_some_and(|n| n > server::UPLOAD_LIMIT) {
        return Err(too_large());
    }
    said("reading", json!({ "done": 0, "total": total }));
    let mut watched = Watched::new(body, stop.clone(), |done| {
        said("reading", json!({ "done": done, "total": total }));
    });
    if !uploaded {
        // Onto this computer: written beside its place as it comes, named once it is whole.
        let root = to.root.as_deref().unwrap_or("");
        let (base, dest) = files::incoming(&ctx.roots, &ctx.kept, root, &to.path, name)
            .map_err(|e| ApiError::new(400, e))?;
        let check: server::Check = &|at| files::may_write(&ctx.kept, at);
        let landing = server::Dest {
            at: &dest,
            new: true,
            check: Some(check),
        };
        server::save_from(&mut watched, total, &landing)?;
        return Ok(files::relative_to(&base, &dest));
    }
    // To the server or a linked computer: read whole, then sent as one upload.
    let bytes = read_whole(&mut watched, server::UPLOAD_LIMIT)
        .map_err(|e| ApiError::new(0, format!("{name}: {e}")))?
        .ok_or_else(too_large)?;
    if stop.load(Ordering::SeqCst) {
        return Err(ApiError::new(0, STOPPED));
    }
    said(
        "sending",
        json!({ "done": bytes.len(), "total": bytes.len() }),
    );
    let (app_url, token) = signed()?;
    if to.place == "server" {
        server::upload_to_library_until(&app_url, &token, &to.path, name, &bytes, Some(stop))?;
    } else {
        server::upload_to_device_until(
            &app_url,
            &token,
            &device_of(to),
            &to.path,
            name,
            &bytes,
            Some(stop),
        )?;
    }
    Ok(name.to_string())
}

/// Read all of `from` -- at most `limit` bytes, or `None` for more than that.
pub fn read_whole(from: &mut impl Read, limit: u64) -> std::io::Result<Option<Vec<u8>>> {
    let mut bytes = Vec::new();
    from.take(limit.saturating_add(1)).read_to_end(&mut bytes)?;
    Ok((bytes.len() as u64 <= limit).then_some(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn what_is_read_is_counted_and_a_stop_ends_it_at_the_next_read() {
        let data = vec![7u8; (STEP * 3 + 10) as usize];
        let stop = Arc::new(AtomicBool::new(false));
        let mut heard = Vec::new();
        let mut w = Watched::new(&data[..], stop.clone(), |n| heard.push(n));
        let mut buf = vec![0u8; STEP as usize];
        let mut got = 0;
        loop {
            let n = w.read(&mut buf).unwrap();
            if n == 0 {
                break;
            }
            got += n;
        }
        drop(w);
        assert_eq!(got, data.len());
        assert_eq!(heard, vec![STEP, STEP * 2, STEP * 3, STEP * 3 + 10]);
        // Stopped part of the way: the next read fails, and nothing more is told.
        let mut heard = Vec::new();
        let mut w = Watched::new(&data[..], stop.clone(), |n| heard.push(n));
        assert_eq!(w.read(&mut buf).unwrap(), STEP as usize);
        stop.store(true, Ordering::SeqCst);
        let e = w.read(&mut buf).unwrap_err();
        assert_eq!(e.to_string(), STOPPED);
        drop(w);
        assert_eq!(heard, vec![STEP]);
    }

    #[test]
    fn a_whole_read_is_all_of_it_or_says_it_is_too_much() {
        let data = [1u8; 100];
        assert_eq!(read_whole(&mut &data[..], 100).unwrap().unwrap().len(), 100);
        assert!(read_whole(&mut &data[..], 99).unwrap().is_none());
        assert_eq!(read_whole(&mut &data[..0], 0).unwrap().unwrap().len(), 0);
    }

    #[test]
    fn a_transfer_is_stopped_by_its_id_and_all_at_once_and_only_so_many_run() {
        let jobs = Jobs::default();
        let (a, stop_a) = jobs.begin().unwrap();
        let (b, stop_b) = jobs.begin().unwrap();
        assert_ne!(a, b);
        assert!(jobs.begin().is_none(), "no third while two run");
        jobs.cancel(a);
        assert!(stop_a.load(Ordering::SeqCst) && !stop_b.load(Ordering::SeqCst));
        jobs.end(a);
        jobs.cancel(a);
        // Wound down: each is told to stop; the one that never ends is not waited for for ever.
        assert!(!jobs.wind_down(Duration::from_millis(60)));
        assert!(stop_b.load(Ordering::SeqCst));
        jobs.end(b);
        assert!(jobs.wind_down(Duration::from_millis(60)));
        let (c, stop_c) = jobs.begin().unwrap();
        assert!(c > b && !stop_c.load(Ordering::SeqCst));
    }

    fn scratch(name: &str) -> (PathBuf, Ctx) {
        let d = std::env::temp_dir().join(format!("llembas-carry-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(d.join("project/in")).unwrap();
        std::fs::create_dir_all(d.join("outside")).unwrap();
        std::fs::write(
            d.join("project/loaf.bin"),
            vec![3u8; (STEP * 2 + 5) as usize],
        )
        .unwrap();
        let d = std::fs::canonicalize(&d).unwrap();
        let ctx = Ctx {
            door: None,
            roots: vec![d.join("project").to_string_lossy().into_owned()],
            kept: Vec::new(),
        };
        (d, ctx)
    }

    fn place(place: &str, root: Option<&str>, path: &str) -> Place {
        Place {
            place: place.into(),
            root: root.map(str::to_string),
            device: Some("token2".into()),
            path: path.into(),
        }
    }

    fn names(dir: &std::path::Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn a_file_lands_whole_under_a_free_name_and_a_stopped_one_leaves_nothing() {
        let (d, ctx) = scratch("land");
        let root = ctx.roots[0].clone();
        let heard = Mutex::new(Vec::new());
        let said = |state: &str, more: Value| heard.lock().unwrap().push((state.to_string(), more));
        let stop = Arc::new(AtomicBool::new(false));
        let from = place("local", Some(&root), "loaf.bin");
        let to = place("local", Some(&root), "in");
        let landed = carry_one(&ctx, &stop, &from, &to, "loaf.bin", &said).unwrap();
        assert_eq!(landed, "in/loaf.bin");
        assert_eq!(
            std::fs::read(d.join("project/in/loaf.bin")).unwrap().len(),
            (STEP * 2 + 5) as usize
        );
        // Again: beside the first, never over it.
        assert_eq!(
            carry_one(&ctx, &stop, &from, &to, "loaf.bin", &said).unwrap(),
            "in/loaf (2).bin"
        );
        // How far it was: from nothing, by steps, to all of it.
        let total = STEP * 2 + 5;
        let first: Vec<u64> = heard
            .lock()
            .unwrap()
            .iter()
            .take(4)
            .map(|(s, m)| {
                assert_eq!(s, "reading");
                assert_eq!(m["total"], total);
                m["done"].as_u64().unwrap()
            })
            .collect();
        assert_eq!(first, vec![0, STEP, STEP * 2, total]);
        // Stopped: nothing of it is left, under any name.
        let before = names(&d.join("project/in"));
        stop.store(true, Ordering::SeqCst);
        assert!(carry_one(&ctx, &stop, &from, &to, "loaf.bin", &said).is_err());
        assert_eq!(names(&d.join("project/in")), before);
        std::fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn a_transfer_goes_only_between_the_places_there_are_and_inside_the_agents_folders() {
        let (d, ctx) = scratch("route");
        let root = ctx.roots[0].clone();
        let said = |_: &str, _: Value| {};
        let stop = Arc::new(AtomicBool::new(false));
        let here = place("local", Some(&root), "loaf.bin");
        let status = |from: &Place, to: &Place, name: &str| {
            carry_one(&ctx, &stop, from, to, name, &said)
                .unwrap_err()
                .status
        };
        // No such place, at either end; a file or a folder outside the agent's folders; a name that is a path.
        assert_eq!(
            status(
                &place("moon", None, "x"),
                &place("local", Some(&root), "in"),
                "x"
            ),
            400
        );
        assert_eq!(status(&here, &place("moon", None, "/x"), "loaf.bin"), 400);
        assert_eq!(
            status(
                &place("local", Some(&root), "../outside/secret"),
                &place("local", Some(&root), "in"),
                "s"
            ),
            400
        );
        assert_eq!(
            status(
                &here,
                &place("local", Some(&root), "../outside"),
                "loaf.bin"
            ),
            400
        );
        let elsewhere = d.join("outside").to_string_lossy().into_owned();
        assert_eq!(
            status(&here, &place("local", Some(&elsewhere), ""), "loaf.bin"),
            400
        );
        assert_eq!(
            status(&here, &place("local", Some(&root), "in"), "../up.bin"),
            400
        );
        assert_eq!(names(&d.join("outside")).len(), 0);
        assert_eq!(names(&d.join("project/in")).len(), 0);
        // To and from the server or a linked computer needs the sign-in: without one nothing is asked of anybody.
        for there in ["server", "device"] {
            assert_eq!(
                status(&here, &place(there, None, "/home/user"), "loaf.bin"),
                401
            );
            assert_eq!(
                status(
                    &place(there, None, "/home/user/loaf.bin"),
                    &place("local", Some(&root), "in"),
                    "loaf.bin"
                ),
                401
            );
        }
        // Too large to be sent is said from its size alone, before the sign-in is even looked for.
        let big = std::fs::File::create(d.join("project/big.iso")).unwrap();
        big.set_len(server::UPLOAD_LIMIT + 1).unwrap();
        assert_eq!(
            status(
                &place("local", Some(&root), "big.iso"),
                &place("server", None, "/home/user"),
                "big.iso"
            ),
            413
        );
        std::fs::remove_dir_all(&d).unwrap();
    }
}
