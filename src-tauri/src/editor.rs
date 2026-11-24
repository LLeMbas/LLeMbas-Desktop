//! The editor's helper in the workspace: a completion as it is typed and a selection rewritten.
//! Both are the LLeMbas CLI's own methods for an editor (harness spec 3.11.0: `_lembas/complete`,
//! `_lembas/edit`), asked of the bundled CLI run as an ACP agent on its stdin and stdout
//! (`lembas serve --stdio`): newline-delimited JSON-RPC 2.0, one message a line. The CLI is run
//! as it is and reaches the server with its own login; nothing of its files is touched here.
//!
//! The page asks through one command with a method from a short list; the answer is the CLI's
//! `result`, or its refusal in words. A request that may be cancelled, or that is written in
//! pieces, carries the page's own `id` in its params (the spec's: not the JSON-RPC id). While a selection is rewritten the CLI
//! sends what it has so far as `_lembas/edit/delta` notifications, which go to the page as
//! `editor` events -- checked first: an id and a piece of text, and nothing else of the message.
//! A CLI from before spec 3.11.0 answers "method not found", which the page is told in a
//! sentence of its own.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};

use crate::cli;
use crate::server::ApiError;

/// What the page may ask of the CLI: the editor's methods of spec 3.11.0, and no other.
pub const METHODS: &[&str] = &[
    "_lembas/complete",
    "_lembas/edit",
    "_lembas/models",
    "_lembas/editor/settings",
];

/// The notification that carries a rewrite as it is written.
const DELTA: &str = "_lembas/edit/delta";
/// The most of one such piece handed to the page.
const MAX_DELTA: usize = 64 * 1024;
/// JSON-RPC's "method not found": a CLI from before the editor's methods.
const NOT_FOUND: i64 = -32601;
/// The JSON-RPC id of the handshake; the requests after it count on from 1.
const HANDSHAKE: u64 = 0;
/// The longest id of the page's own for a request.
const MAX_ID: usize = 64;

type Answer = Result<Value, ApiError>;
type Waiting = Arc<Mutex<HashMap<u64, Sender<Answer>>>>;

struct Running {
    child: Mutex<Child>,
    stdin: Mutex<ChildStdin>,
    waiting: Waiting,
    next: AtomicU64,
}

impl Running {
    fn alive(&self) -> bool {
        matches!(self.child.lock().unwrap().try_wait(), Ok(None))
    }

    fn kill(&self) {
        let mut child = self.child.lock().unwrap();
        let _ = child.kill();
        let _ = child.wait();
    }
}

/// The CLI as the editor's helper: started when first asked, started again when it has gone.
///
/// Two locks, on purpose. `running` is held only for as long as it takes to look at what runs
/// or to put it there -- never while the CLI is started and greeted, which may take as long as
/// the greeting is waited for: a cancel sent meanwhile finds nothing running and returns at
/// once. `starting` is what makes two requests that both find nothing start one CLI, not two.
#[derive(Default)]
pub struct Helper {
    running: Mutex<Option<Arc<Running>>>,
    starting: Mutex<()>,
    /// What is run in the CLI's place, and how long it is waited for (the tests' stand-in).
    stand_in: Option<StandIn>,
}

#[cfg_attr(not(test), allow(dead_code))]
struct StandIn {
    program: PathBuf,
    args: Vec<String>,
    greeting: Duration,
    patience: Duration,
}

pub fn allowed(method: &str) -> bool {
    METHODS.contains(&method)
}

/// How long an answer is waited for: a rewrite is a whole reply of a model, the rest are short.
fn patience(method: &str) -> Duration {
    Duration::from_secs(if method == "_lembas/edit" { 600 } else { 60 })
}

/// How long the CLI may take to answer the greeting.
const GREETING: Duration = Duration::from_secs(30);

/// An id of the page's own for a request: a short plain name.
pub fn plain_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_ID
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// A rewrite's piece as the page gets it: `{ id, delta }` where the message says exactly that,
/// an id that is a plain name and a text of a bounded size; nothing for anything else.
pub fn delta(params: &Value) -> Option<Value> {
    let id = params.get("id")?.as_str()?;
    let text = params.get("delta")?.as_str()?;
    if !plain_id(id) || text.len() > MAX_DELTA {
        return None;
    }
    Some(json!({ "id": id, "delta": text }))
}

/// The CLI's refusal, as the page says it: its own sentence, or -- a CLI that does not know the
/// method -- ours.
pub fn refusal(error: &Value) -> ApiError {
    let code = error.get("code").and_then(Value::as_i64).unwrap_or(0);
    if code == NOT_FOUND {
        return ApiError::new(
            501,
            "This needs a newer LLeMbas CLI than the one in this app.",
        );
    }
    let message = error
        .get("message")
        .and_then(Value::as_str)
        .filter(|m| !m.trim().is_empty())
        .unwrap_or("The LLeMbas CLI refused.");
    ApiError::new(400, message)
}

fn send(stdin: &Mutex<ChildStdin>, message: &Value) -> std::io::Result<()> {
    let mut line = message.to_string();
    line.push('\n');
    let mut stdin = stdin.lock().unwrap();
    stdin.write_all(line.as_bytes())?;
    stdin.flush()
}

/// Read the CLI's lines until it closes: an answer goes to whoever waits for its id, a piece of
/// a rewrite to the page, and everything else is left unread. Once the CLI is gone, nobody
/// waits for ever.
fn read(stdout: ChildStdout, waiting: &Waiting, notify: &dyn Fn(Value)) {
    for line in BufReader::new(stdout).lines() {
        let Ok(line) = line else { break };
        let Ok(message) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if let Some(method) = message.get("method").and_then(Value::as_str) {
            if method == DELTA {
                if let Some(note) = message.get("params").and_then(delta) {
                    notify(note);
                }
            }
            continue;
        }
        let Some(id) = message.get("id").and_then(Value::as_u64) else {
            continue;
        };
        let Some(tx) = waiting.lock().unwrap().remove(&id) else {
            continue;
        };
        let answer = match message.get("error") {
            Some(e) if !e.is_null() => Err(refusal(e)),
            _ => Ok(message.get("result").cloned().unwrap_or(Value::Null)),
        };
        let _ = tx.send(answer);
    }
    for (_, tx) in waiting.lock().unwrap().drain() {
        let _ = tx.send(Err(ApiError::new(0, "The LLeMbas CLI stopped.")));
    }
}

/// Start the CLI and greet it as an editor (`clientCapabilities._meta.lembas.editor`).
fn start(
    program: PathBuf,
    args: &[String],
    greeting: Duration,
    notify: impl Fn(Value) + Send + 'static,
) -> Result<Running, ApiError> {
    let failed =
        |why: String| ApiError::new(0, format!("The LLeMbas CLI could not be started: {why}"));
    let mut child = Command::new(program)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| failed(e.to_string()))?;
    let (Some(stdin), Some(stdout)) = (child.stdin.take(), child.stdout.take()) else {
        let _ = child.kill();
        let _ = child.wait();
        return Err(failed("no way to talk to it".into()));
    };
    let stdin = Mutex::new(stdin);
    let waiting: Waiting = Arc::default();
    let (tx, rx) = mpsc::channel();
    waiting.lock().unwrap().insert(HANDSHAKE, tx);
    let theirs = waiting.clone();
    std::thread::spawn(move || read(stdout, &theirs, &notify));
    let hello = json!({
        "jsonrpc": "2.0",
        "id": HANDSHAKE,
        "method": "initialize",
        "params": {
            "protocolVersion": 1,
            "clientCapabilities": { "_meta": { "lembas": { "editor": true, "protocol": 3 } } },
            "clientInfo": { "name": "LLeMbas Desktop", "version": env!("CARGO_PKG_VERSION") },
        },
    });
    let greeted = match send(&stdin, &hello) {
        Ok(()) => match rx.recv_timeout(greeting) {
            Ok(Ok(_)) => Ok(()),
            Ok(Err(e)) => Err(e),
            Err(_) => Err(failed("it did not answer".into())),
        },
        Err(e) => Err(failed(e.to_string())),
    };
    if let Err(e) = greeted {
        let _ = child.kill();
        let _ = child.wait();
        return Err(e);
    }
    Ok(Running {
        child: Mutex::new(child),
        stdin,
        waiting,
        next: AtomicU64::new(HANDSHAKE),
    })
}

impl Helper {
    /// What runs now, where it still does.
    fn current(&self) -> Option<Arc<Running>> {
        self.running
            .lock()
            .unwrap()
            .as_ref()
            .filter(|r| r.alive())
            .cloned()
    }

    /// The CLI to ask: the one that runs, or a new one -- started and greeted with the lock on
    /// the running one let go, so nothing waits for the greeting but another start.
    fn ready(&self, notify: impl Fn(Value) + Send + 'static) -> Result<Arc<Running>, ApiError> {
        if let Some(r) = self.current() {
            return Ok(r);
        }
        let _one = self.starting.lock().unwrap();
        // (Started by whoever held `starting` before this one: that is the one.)
        if let Some(r) = self.current() {
            return Ok(r);
        }
        let fresh = match &self.stand_in {
            Some(s) => start(s.program.clone(), &s.args, s.greeting, notify),
            None => start(
                cli::binary(),
                &["serve".to_string(), "--stdio".to_string()],
                GREETING,
                notify,
            ),
        }?;
        let fresh = Arc::new(fresh);
        let old = self.running.lock().unwrap().replace(fresh.clone());
        if let Some(old) = old {
            old.kill();
        }
        Ok(fresh)
    }

    /// Ask the CLI: `method` with `params`. Waits for the answer. `notify` gets the pieces of a
    /// rewrite (named by the id the page put into the rewrite's params).
    pub fn call(
        &self,
        method: &str,
        params: Value,
        notify: impl Fn(Value) + Send + 'static,
    ) -> Answer {
        if !allowed(method) {
            return Err(ApiError::new(
                400,
                format!("Not one of the editor's methods: {method}"),
            ));
        }
        let r = self.ready(notify)?;
        let (tx, rx) = mpsc::channel();
        let id = r.next.fetch_add(1, Ordering::SeqCst) + 1;
        r.waiting.lock().unwrap().insert(id, tx);
        let request = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        if let Err(e) = send(&r.stdin, &request) {
            r.waiting.lock().unwrap().remove(&id);
            return Err(ApiError::new(0, e.to_string()));
        }
        let wait = self
            .stand_in
            .as_ref()
            .map_or_else(|| patience(method), |s| s.patience);
        match rx.recv_timeout(wait) {
            Ok(answer) => answer,
            Err(_) => {
                r.waiting.lock().unwrap().remove(&id);
                Err(ApiError::new(0, "The LLeMbas CLI did not answer in time."))
            }
        }
    }

    /// Tell the CLI that the completion (or, `edit`, the rewrite) asked for under the page's
    /// `id` is no longer wanted. Its request is still answered by the CLI (with nothing). Where
    /// no CLI runs -- one not yet greeted included -- there is nothing to tell, and this
    /// returns at once.
    pub fn cancel(&self, id: &str, edit: bool) {
        if !plain_id(id) {
            return;
        }
        let Some(r) = self.running.lock().unwrap().clone() else {
            return;
        };
        let method = if edit {
            "_lembas/edit/cancel"
        } else {
            "_lembas/complete/cancel"
        };
        let note = json!({ "jsonrpc": "2.0", "method": method, "params": { "id": id } });
        let _ = send(&r.stdin, &note);
    }

    /// Stop the CLI: the app is closing or starting again, the person signed out, the sign-in
    /// was refused, another server was chosen. Whoever waits for an answer is told it stopped.
    pub fn stop(&self) {
        let old = self.running.lock().unwrap().take();
        if let Some(r) = old {
            r.kill();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_editors_methods_are_asked() {
        assert!(allowed("_lembas/complete"));
        assert!(allowed("_lembas/edit"));
        assert!(!allowed("session/prompt"));
        assert!(!allowed("_lembas/fs/write"));
        assert!(!allowed(""));
    }

    #[test]
    fn a_piece_of_a_rewrite_is_an_id_and_a_text_or_nothing() {
        let ok = json!({ "id": "e7", "delta": "let x", "more": { "a": 1 } });
        assert_eq!(delta(&ok), Some(json!({ "id": "e7", "delta": "let x" })));
        assert_eq!(delta(&json!({ "id": 7, "delta": "x" })), None);
        assert_eq!(delta(&json!({ "id": "e 7", "delta": "x" })), None);
        assert_eq!(delta(&json!({ "id": "e7", "delta": 3 })), None);
        assert_eq!(delta(&json!({ "delta": "x" })), None);
        assert_eq!(delta(&json!("x")), None);
        let long = "a".repeat(MAX_DELTA + 1);
        assert_eq!(delta(&json!({ "id": "e7", "delta": long })), None);
    }

    #[test]
    fn a_refusal_is_the_clis_sentence_and_an_old_cli_is_said_as_one() {
        let old = refusal(&json!({ "code": -32601, "message": "Method not found" }));
        assert_eq!(old.status, 501);
        assert!(old.detail.contains("newer LLeMbas CLI"));
        let said = refusal(&json!({ "code": -32000, "message": "Not logged in." }));
        assert_eq!((said.status, said.detail.as_str()), (400, "Not logged in."));
        let empty = refusal(&json!({ "code": -32000, "message": " " }));
        assert_eq!(empty.detail, "The LLeMbas CLI refused.");
    }

    /// A stand-in for the CLI, in the shell: it answers the greeting (after `slow` seconds),
    /// answers `_lembas/models` with its own process id, never answers `_lembas/complete`, and
    /// goes away when asked for `_lembas/editor/settings`.
    #[cfg(unix)]
    fn stand_in(slow: &str, patience: Duration) -> Helper {
        let script = [
            "while IFS= read -r line; do",
            r#"  id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9][0-9]*\)[,}].*/\1/p')"#,
            r#"  case "$line" in"#,
            &format!(
                r#"    *'"initialize"'*) sleep {slow}; printf '{{"jsonrpc":"2.0","id":%s,"result":{{}}}}\n' "$id" ;;"#
            ),
            r#"    *'"_lembas/models"'*) printf '{"jsonrpc":"2.0","id":%s,"result":{"pid":%s}}\n' "$id" "$$" ;;"#,
            r#"    *'"_lembas/editor/settings"'*) exit 0 ;;"#,
            "  esac",
            "done",
        ]
        .join("\n");
        Helper {
            stand_in: Some(StandIn {
                program: PathBuf::from("sh"),
                args: vec!["-c".into(), script],
                greeting: Duration::from_secs(10),
                patience,
            }),
            ..Helper::default()
        }
    }

    #[cfg(unix)]
    fn pid_of(h: &Helper) -> u64 {
        let answer = h.call("_lembas/models", json!({}), |_| {}).unwrap();
        answer["pid"].as_u64().unwrap()
    }

    #[cfg(unix)]
    #[test]
    fn the_cli_is_started_once_and_started_again_when_it_has_gone() {
        let h = stand_in("0", Duration::from_secs(10));
        let first = pid_of(&h);
        assert_eq!(pid_of(&h), first, "one CLI for one request after another");
        // It goes away under a request: that request is told, and the next one finds a new CLI.
        let gone = h
            .call("_lembas/editor/settings", json!({}), |_| {})
            .unwrap_err();
        assert_eq!(gone.detail, "The LLeMbas CLI stopped.");
        let second = pid_of(&h);
        assert_ne!(second, first);
        // Stopped from here (signed out): the same.
        h.stop();
        assert_ne!(pid_of(&h), second);
        h.stop();
    }

    #[cfg(unix)]
    #[test]
    fn a_request_never_answered_ends_in_words_and_the_cli_goes_on() {
        let h = stand_in("0", Duration::from_millis(300));
        let before = pid_of(&h);
        let began = std::time::Instant::now();
        let late = h
            .call(
                "_lembas/complete",
                json!({ "id": "c1", "prefix": "x" }),
                |_| {},
            )
            .unwrap_err();
        assert_eq!(late.detail, "The LLeMbas CLI did not answer in time.");
        assert!(began.elapsed() < Duration::from_secs(5));
        assert_eq!(pid_of(&h), before, "the CLI was not started again for it");
        // What is not the editor's is never sent at all.
        let other = h.call("session/prompt", json!({}), |_| {}).unwrap_err();
        assert_eq!(other.status, 400);
        h.stop();
    }

    #[cfg(unix)]
    #[test]
    fn a_cancel_does_not_wait_for_a_cli_that_is_still_being_greeted() {
        let h = Arc::new(stand_in("2", Duration::from_secs(10)));
        let asking = h.clone();
        let first = std::thread::spawn(move || pid_of(&asking));
        // (The first request is at the greeting by now, which takes two seconds.)
        std::thread::sleep(Duration::from_millis(400));
        let began = std::time::Instant::now();
        h.cancel("c1", false);
        h.cancel("e1", true);
        assert!(
            began.elapsed() < Duration::from_millis(500),
            "a cancel waited {:?} for the greeting",
            began.elapsed()
        );
        // A second request meanwhile waits for the same CLI: one is started, not two.
        let second = pid_of(&h);
        assert_eq!(first.join().unwrap(), second);
        h.stop();
    }

    #[test]
    fn a_cli_that_cannot_be_started_is_said() {
        let h = Helper {
            stand_in: Some(StandIn {
                program: PathBuf::from("/nonexistent/llembas-no-such-cli"),
                args: Vec::new(),
                greeting: Duration::from_millis(200),
                patience: Duration::from_millis(200),
            }),
            ..Helper::default()
        };
        let e = h.call("_lembas/models", json!({}), |_| {}).unwrap_err();
        assert!(
            e.detail.starts_with("The LLeMbas CLI could not be started"),
            "{}",
            e.detail
        );
    }
}
