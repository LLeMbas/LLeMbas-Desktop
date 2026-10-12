//! The agent: `lembas service run` as a child of the app, kept running while it is wanted.
//!
//! That one process is what makes this computer a device of the server — agent chats started in
//! the web UI run here, in this computer's projects. It is the CLI's own service loop, unchanged;
//! the app only starts it, restarts it when it fails, and stops it (SIGTERM first, so a turn in
//! progress ends cleanly) when the agent is switched off or the app quits.

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

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "state", content = "detail", rename_all = "snake_case")]
pub enum State {
    /// Not wanted.
    Off,
    /// This computer is not signed in to the server yet.
    NotLinked,
    Starting,
    Running,
    /// Another `lembas service` on this computer holds the link (its pid).
    Elsewhere(u32),
    /// It ended with an error; trying again shortly.
    Failed(String),
}

impl State {
    pub fn label(&self) -> String {
        match self {
            State::Off => "Agent: off".into(),
            State::NotLinked => "Agent: this computer is not linked".into(),
            State::Starting => "Agent: starting…".into(),
            State::Running => "Agent: running".into(),
            State::Elsewhere(pid) => format!("Agent: running as a service (pid {pid})"),
            State::Failed(why) => format!("Agent: stopped — {why}"),
        }
    }
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
                if !self.set(generation, State::Elsewhere(pid)) {
                    return;
                }
                self.pause(generation, BACKOFF);
                continue;
            }
            if !self.set(generation, State::Starting) {
                return;
            }
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
            {
                let mut g = self.inner.lock().unwrap();
                if g.generation != generation {
                    drop(g);
                    terminate(child);
                    return;
                }
                g.child = Some(child);
            }
            self.set(generation, State::Running);
            let code = self.wait_child(generation);
            let mut g = self.inner.lock().unwrap();
            if g.generation != generation {
                return;
            }
            g.child = None;
            drop(g);
            match code {
                Some(RESTART_FOR_UPDATE) => continue,
                Some(0) => {
                    // It ended by itself without an error: nothing to do but start it again.
                    self.pause(generation, Duration::from_secs(1));
                }
                other => {
                    let why = other.map_or("ended by a signal".to_string(), |c| {
                        format!("exit status {c}")
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
    fn wait_child(&self, generation: u64) -> Option<i32> {
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
