//! A file carried from one place to another -- this computer, the server, a linked computer --
//! whatever it holds: read from where it is as it comes, counted so the page can say how far it
//! is, and stopped at once when the person cancels. Where it lands on this computer it is
//! written beside its place and named only once whole (`server::save_from`), so a transfer that
//! breaks off or is cancelled leaves nothing behind; where it goes to the server or to a linked
//! computer it is read whole first and sent as one upload, which the other side takes or refuses
//! as a whole.

use std::collections::HashMap;
use std::io::Read;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

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
    /// A new transfer: its id for the page, and its switch.
    pub fn begin(&self) -> (u64, Arc<AtomicBool>) {
        let id = self.next.fetch_add(1, Ordering::SeqCst) + 1;
        let stop = Arc::new(AtomicBool::new(false));
        self.stops.lock().unwrap().insert(id, stop.clone());
        (id, stop)
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
    fn a_transfer_is_stopped_by_its_id_and_all_at_once() {
        let jobs = Jobs::default();
        let (a, stop_a) = jobs.begin();
        let (b, stop_b) = jobs.begin();
        assert_ne!(a, b);
        jobs.cancel(a);
        assert!(stop_a.load(Ordering::SeqCst) && !stop_b.load(Ordering::SeqCst));
        jobs.end(a);
        jobs.cancel(a);
        jobs.cancel_all();
        assert!(stop_b.load(Ordering::SeqCst));
        jobs.end(b);
        let (c, stop_c) = jobs.begin();
        assert!(c > b && !stop_c.load(Ordering::SeqCst));
    }
}
