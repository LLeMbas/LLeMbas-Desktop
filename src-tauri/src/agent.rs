//! The agent: `lembas service run` as a child of the app, kept running while it is wanted.
//!
//! That one process is what makes this computer a device of the server — agent chats started in
//! the web UI run here, in this computer's projects. It is the CLI's own service loop, unchanged;
//! the app only starts it, restarts it when it fails, and stops it (SIGTERM first, so a turn in
//! progress ends cleanly) when the agent is switched off or the app quits.
//!
//! What it shows is the CLI's own word: a process that runs is not an agent that is linked. While
//! it runs, the state is what the service writes to its `service.json` (connecting, linked,
//! waiting and why, stopped and why); before that, the line it printed; when it ends, its last
//! line. A service the CLI says cannot go on (a refused token, no login) is not restarted every
//! second: it waits until linking again starts it.

use std::fs::{File, OpenOptions};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::cli;

/// The CLI's "updated on disk, start me again" exit status.
const RESTART_FOR_UPDATE: i32 = 75;
const BACKOFF: Duration = Duration::from_secs(10);
const STOP_GRACE: Duration = Duration::from_secs(15);
/// How long to wait before trying again after the CLI said trying again will not help.
const REFUSED_WAIT: Duration = Duration::from_secs(300);

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "state", content = "detail", rename_all = "snake_case")]
pub enum State {
    /// Not wanted.
    Off,
    /// This computer is not signed in to the server yet.
    NotLinked,
    /// The process is started; the CLI has not said anything of its link yet.
    Starting,
    /// The CLI is dialling the server.
    Connecting,
    /// The CLI says it is linked: agent chats can use this computer.
    Running,
    /// Not linked right now, and trying again: the CLI's own reason (a terminal holds the link,
    /// the server cannot be reached, the link dropped).
    Waiting(String),
    /// The CLI will not try again by itself: the server refused this computer's token, or the
    /// login is missing. Linking again is the way out.
    Refused(String),
    /// Another `lembas service` on this computer holds the link.
    Elsewhere(Elsewhere),
    /// It ended with an error; trying again shortly. The CLI's last words, where it said any.
    Failed(String),
}

/// A `lembas service` this app did not start, and what it says of its link.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Elsewhere {
    pub pid: u32,
    /// It says it is linked.
    pub linked: bool,
    /// Why not, when it is not (its own words; empty while it has said nothing).
    pub why: String,
}

impl State {
    pub fn label(&self) -> String {
        match self {
            State::Off => "Agent: off".into(),
            State::NotLinked => "Agent: this computer is not linked".into(),
            State::Starting => "Agent: starting…".into(),
            State::Connecting => "Agent: connecting…".into(),
            State::Running => "Agent: running".into(),
            State::Waiting(why) => format!("Agent: waiting — {why}"),
            State::Refused(why) => format!("Agent: refused — {why}"),
            State::Elsewhere(e) if e.linked => {
                format!("Agent: running as a service (pid {})", e.pid)
            }
            State::Elsewhere(e) => format!("Agent: a service (pid {}) is not linked", e.pid),
            State::Failed(why) => format!("Agent: stopped — {why}"),
        }
    }

    /// Whether this is a state the CLI's own status file decides, while the process runs.
    fn told_by_cli(&self) -> bool {
        matches!(
            self,
            State::Starting | State::Connecting | State::Running | State::Waiting(_)
        )
    }
}

/// What the CLI's status says, as a state of the app's. `before`: the state shown now, so that a
/// new dial after a failed one keeps the reason it is waiting (the CLI writes `connecting` at
/// every try, `waiting` between them) instead of flickering between the two.
pub fn from_link(link: &cli::Link, before: &State) -> State {
    let why = link.detail.clone().unwrap_or_default();
    match link.state.as_str() {
        "linked" => State::Running,
        "connecting" => match before {
            State::Waiting(w) if link.attempts > 1 => State::Waiting(w.clone()),
            _ => State::Connecting,
        },
        "waiting" => State::Waiting(why),
        "stopped" => State::Refused(why),
        _ => State::Starting,
    }
}

/// What a running process has said before its status file says anything: the one line the
/// CLI's service writes while a terminal on this computer holds the link for `/remote`.
fn from_output(line: &str) -> Option<State> {
    line.contains("holds the link")
        .then(|| State::Waiting(line.trim().to_string()))
}

type Notify = Arc<dyn Fn(&State) + Send + Sync>;

struct Inner {
    wanted: bool,
    /// Bumped by every start and stop, so an old supervisor notices it is no longer the one.
    generation: u64,
    child: Option<Child>,
    state: State,
}

#[derive(Clone)]
pub struct Agent {
    inner: Arc<Mutex<Inner>>,
    notify: Notify,
    log: PathBuf,
}

impl Agent {
    pub fn new(log: PathBuf, notify: impl Fn(&State) + Send + Sync + 'static) -> Self {
        Agent {
            inner: Arc::new(Mutex::new(Inner {
                wanted: false,
                generation: 0,
                child: None,
                state: State::Off,
            })),
            notify: Arc::new(notify),
            log,
        }
    }

    pub fn state(&self) -> State {
        self.inner.lock().unwrap().state.clone()
    }

    pub fn wanted(&self) -> bool {
        self.inner.lock().unwrap().wanted
    }

    fn set(&self, generation: u64, state: State) -> bool {
        let mut g = self.inner.lock().unwrap();
        if g.generation != generation {
            return false;
        }
        if g.state != state {
            g.state = state.clone();
            drop(g);
            (self.notify)(&state);
        }
        true
    }

    /// Run the agent for `server`, and keep it running until `stop`.
    pub fn start(&self, server: String) {
        self.stop();
        let generation = {
            let mut g = self.inner.lock().unwrap();
            g.wanted = true;
            g.generation += 1;
            g.generation
        };
        let me = self.clone();
        thread::spawn(move || me.supervise(generation, server));
    }

    fn supervise(&self, generation: u64, server: String) {
        loop {
            if !cli::linked_to(&server) {
                if !self.set(generation, State::NotLinked) {
                    return;
                }
                self.pause(generation, BACKOFF);
                continue;
            }
            if let Some(pid) = cli::running_service().filter(|p| Some(*p) != self.child_pid()) {
                // Not ours, but this computer's agent all the same: say what it says.
                let link = cli::link_of(pid);
                let linked = link.as_ref().is_some_and(|l| l.state == "linked");
                let why = link
                    .map(|l| match l.detail {
                        Some(d) if !d.is_empty() => d,
                        _ => l.state,
                    })
                    .unwrap_or_default();
                if !self.set(
                    generation,
                    State::Elsewhere(Elsewhere {
                        pid,
                        linked,
                        why: if linked { String::new() } else { why },
                    }),
                ) {
                    return;
                }
                self.pause(generation, Duration::from_secs(3));
                continue;
            }
            if !self.set(generation, State::Starting) {
                return;
            }
            // Where this run's output starts in the log: its last line is its reason.
            let from = std::fs::metadata(&self.log).map(|m| m.len()).unwrap_or(0);
            let child = match self.spawn() {
                Ok(c) => c,
                Err(e) => {
                    if !self.set(
                        generation,
                        State::Failed(format!("could not start {}: {e}", cli::binary().display())),
                    ) {
                        return;
                    }
                    self.pause(generation, BACKOFF);
                    continue;
                }
            };
            let pid = child.id();
            {
                let mut g = self.inner.lock().unwrap();
                if g.generation != generation {
                    drop(g);
                    terminate(child);
                    return;
                }
                g.child = Some(child);
            }
            let code = self.wait_child(generation, pid, from);
            let mut g = self.inner.lock().unwrap();
            if g.generation != generation {
                return;
            }
            g.child = None;
            drop(g);
            let said = last_line(&self.log, from);
            match code {
                Some(RESTART_FOR_UPDATE) => continue,
                Some(0) => {
                    // It ended by itself without an error: the CLI's word for "starting again
                    // will not help" -- the server refused the token, or there is no login.
                    // Waiting a long while (linking again starts it at once).
                    let why = cli::link_of(pid)
                        .filter(|l| l.state == "stopped")
                        .and_then(|l| l.detail)
                        .or_else(|| said.map(|s| strip_prefix(&s)));
                    match why {
                        Some(why) => {
                            if !self.set(generation, State::Refused(why)) {
                                return;
                            }
                            self.pause(generation, REFUSED_WAIT);
                        }
                        None => self.pause(generation, Duration::from_secs(1)),
                    }
                }
                other => {
                    let why = said.map(|s| strip_prefix(&s)).unwrap_or_else(|| {
                        other.map_or("ended by a signal".to_string(), |c| {
                            format!("exit status {c}")
                        })
                    });
                    if !self.set(generation, State::Failed(why)) {
                        return;
                    }
                    self.pause(generation, BACKOFF);
                }
            }
        }
    }

    fn spawn(&self) -> std::io::Result<Child> {
        let (out, err) = self.log_handles();
        Command::new(cli::binary())
            .args(["service", "run"])
            .stdin(Stdio::null())
            .stdout(out)
            .stderr(err)
            .spawn()
    }

    fn log_handles(&self) -> (Stdio, Stdio) {
        let open = || -> Option<File> {
            if let Some(d) = self.log.parent() {
                std::fs::create_dir_all(d).ok()?;
            }
            OpenOptions::new()
                .create(true)
                .append(true)
                .open(&self.log)
                .ok()
        };
        match open() {
            Some(f) => match f.try_clone() {
                Ok(f2) => (Stdio::from(f), Stdio::from(f2)),
                Err(_) => (Stdio::from(f), Stdio::null()),
            },
            None => (Stdio::null(), Stdio::null()),
        }
    }

    fn child_pid(&self) -> Option<u32> {
        self.inner.lock().unwrap().child.as_ref().map(|c| c.id())
    }

    /// Poll the child until it exits (its exit code), or until this supervisor is replaced.
    /// Meanwhile the state shown is what the CLI says of its link: its status file once it has
    /// written one, before that the line it printed (a terminal holding the link).
    fn wait_child(&self, generation: u64, pid: u32, from: u64) -> Option<i32> {
        // Every other poll (once a second) the status is read again.
        let mut read = true;
        loop {
            {
                let mut g = self.inner.lock().unwrap();
                if g.generation != generation {
                    return None;
                }
                match g.child.as_mut().map(|c| c.try_wait()) {
                    Some(Ok(Some(status))) => return status.code(),
                    Some(Ok(None)) => {}
                    Some(Err(_)) | None => return None,
                }
            }
            if read {
                let now = self.state();
                if now.told_by_cli() {
                    let next = match cli::link_of(pid) {
                        Some(link) => from_link(&link, &now),
                        None => last_line(&self.log, from)
                            .and_then(|l| from_output(&l))
                            .unwrap_or(State::Starting),
                    };
                    if !self.set(generation, next) {
                        return None;
                    }
                }
            }
            read = !read;
            thread::sleep(Duration::from_millis(500));
        }
    }

    /// Sleep, waking early when this supervisor is replaced.
    fn pause(&self, generation: u64, d: Duration) {
        let until = Instant::now() + d;
        while Instant::now() < until {
            if self.inner.lock().unwrap().generation != generation {
                return;
            }
            thread::sleep(Duration::from_millis(250));
        }
    }

    /// Stop the agent, waiting for it to end its work (at most `STOP_GRACE`).
    pub fn stop(&self) {
        let child = {
            let mut g = self.inner.lock().unwrap();
            g.wanted = false;
            g.generation += 1;
            g.child.take()
        };
        if let Some(c) = child {
            terminate(c);
        }
        let mut g = self.inner.lock().unwrap();
        if g.state != State::Off {
            g.state = State::Off;
            drop(g);
            (self.notify)(&State::Off);
        }
    }
}

/// SIGTERM, then SIGKILL after the grace period. The service ends its own work in seconds.
fn terminate(mut child: Child) {
    #[cfg(unix)]
    unsafe {
        libc::kill(child.id() as libc::pid_t, libc::SIGTERM);
    }
    #[cfg(not(unix))]
    let _ = child.kill();
    let until = Instant::now() + STOP_GRACE;
    while Instant::now() < until {
        if let Ok(Some(_)) = child.try_wait() {
            return;
        }
        thread::sleep(Duration::from_millis(100));
    }
    let _ = child.kill();
    let _ = child.wait();
}

/// The last line the log holds after `from` (this run's output), if it wrote any. Only the end of
/// the file is read.
fn last_line(log: &std::path::Path, from: u64) -> Option<String> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = File::open(log).ok()?;
    let len = f.metadata().ok()?.len();
    let start = from.max(len.saturating_sub(4096));
    if start >= len {
        return None;
    }
    f.seek(SeekFrom::Start(start)).ok()?;
    let mut buf = Vec::new();
    f.take(len - start).read_to_end(&mut buf).ok()?;
    String::from_utf8_lossy(&buf)
        .lines()
        .rev()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .map(String::from)
}

/// `lembas service: not logged in` → `not logged in`: the CLI's error line without its name.
fn strip_prefix(line: &str) -> String {
    line.strip_prefix("lembas service: ")
        .unwrap_or(line)
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn link(state: &str, detail: Option<&str>, attempts: u32) -> cli::Link {
        cli::Link {
            state: state.into(),
            detail: detail.map(String::from),
            pid: 1,
            attempts,
        }
    }

    #[test]
    fn the_state_shown_is_the_clis_word_for_its_link() {
        let s = State::Starting;
        assert_eq!(from_link(&link("linked", None, 1), &s), State::Running);
        assert_eq!(
            from_link(&link("connecting", None, 1), &s),
            State::Connecting
        );
        let waiting = from_link(
            &link("waiting", Some("could not reach the instance"), 1),
            &s,
        );
        assert_eq!(
            waiting,
            State::Waiting("could not reach the instance".into())
        );
        // The next dial keeps the reason it is waiting, rather than flicker.
        assert_eq!(from_link(&link("connecting", None, 2), &waiting), waiting);
        assert_eq!(
            from_link(&link("stopped", Some("refused"), 2), &waiting),
            State::Refused("refused".into())
        );
        // Not running is never shown as running.
        for state in ["connecting", "waiting", "stopped", "?"] {
            assert_ne!(from_link(&link(state, None, 1), &s), State::Running);
        }
    }

    #[test]
    fn a_terminal_holding_the_link_is_said() {
        assert_eq!(
            from_output("a terminal here holds the link (/remote); waiting for it to close"),
            Some(State::Waiting(
                "a terminal here holds the link (/remote); waiting for it to close".into()
            ))
        );
        assert_eq!(from_output("linked"), None);
    }

    #[test]
    fn the_last_line_is_this_runs_own() {
        let p = std::env::temp_dir().join(format!("llembas-agent-log-{}", std::process::id()));
        std::fs::write(&p, "old run\nlinked\n").unwrap();
        let from = std::fs::metadata(&p).unwrap().len();
        assert_eq!(last_line(&p, from), None);
        let mut f = OpenOptions::new().append(true).open(&p).unwrap();
        std::io::Write::write_all(&mut f, b"connecting\nlembas service: not logged in\n\n")
            .unwrap();
        let said = last_line(&p, from).unwrap();
        assert_eq!(said, "lembas service: not logged in");
        assert_eq!(strip_prefix(&said), "not logged in");
        std::fs::remove_file(&p).unwrap();
    }
}
