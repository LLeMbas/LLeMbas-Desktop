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
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
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
    child: Child,
    stdin: ChildStdin,
    waiting: Waiting,
    next: u64,
}

/// The CLI as the editor's helper: started when first asked, started again when it has gone.
#[derive(Default)]
pub struct Helper {
    running: Mutex<Option<Running>>,
}

pub fn allowed(method: &str) -> bool {
    METHODS.contains(&method)
}

/// How long an answer is waited for: a rewrite is a whole reply of a model, the rest are short.
fn patience(method: &str) -> Duration {
    Duration::from_secs(if method == "_lembas/edit" { 600 } else { 60 })
}

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

fn send(stdin: &mut ChildStdin, message: &Value) -> std::io::Result<()> {
    let mut line = message.to_string();
    line.push('\n');
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
fn start(notify: impl Fn(Value) + Send + 'static) -> Result<Running, ApiError> {
    let failed =
        |why: String| ApiError::new(0, format!("The LLeMbas CLI could not be started: {why}"));
    let mut child = Command::new(cli::binary())
        .args(["serve", "--stdio"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| failed(e.to_string()))?;
    let (Some(mut stdin), Some(stdout)) = (child.stdin.take(), child.stdout.take()) else {
        let _ = child.kill();
        let _ = child.wait();
        return Err(failed("no way to talk to it".into()));
    };
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
    let greeted = match send(&mut stdin, &hello) {
        Ok(()) => match rx.recv_timeout(Duration::from_secs(30)) {
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
        child,
        stdin,
        waiting,
        next: HANDSHAKE,
    })
}

impl Helper {
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
        let (tx, rx) = mpsc::channel();
        let id;
        {
            let mut guard = self.running.lock().unwrap();
            let gone = match guard.as_mut() {
                Some(r) => !matches!(r.child.try_wait(), Ok(None)),
                None => true,
            };
            if gone {
                *guard = Some(start(notify)?);
            }
            let Some(r) = guard.as_mut() else {
                return Err(ApiError::new(0, "The LLeMbas CLI is not running."));
            };
            r.next += 1;
            id = r.next;
            r.waiting.lock().unwrap().insert(id, tx);
            let request = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
            if let Err(e) = send(&mut r.stdin, &request) {
                r.waiting.lock().unwrap().remove(&id);
                return Err(ApiError::new(0, e.to_string()));
            }
        }
        match rx.recv_timeout(patience(method)) {
            Ok(answer) => answer,
            Err(_) => {
                if let Some(r) = self.running.lock().unwrap().as_ref() {
                    r.waiting.lock().unwrap().remove(&id);
                }
                Err(ApiError::new(0, "The LLeMbas CLI did not answer in time."))
            }
        }
    }

    /// Tell the CLI that the completion (or, `edit`, the rewrite) asked for under the page's
    /// `id` is no longer wanted. Its request is still answered by the CLI (with nothing); where
    /// the CLI is not running there is nothing to tell.
    pub fn cancel(&self, id: &str, edit: bool) {
        if !plain_id(id) {
            return;
        }
        if let Some(r) = self.running.lock().unwrap().as_mut() {
            let method = if edit {
                "_lembas/edit/cancel"
            } else {
                "_lembas/complete/cancel"
            };
            let note = json!({ "jsonrpc": "2.0", "method": method, "params": { "id": id } });
            let _ = send(&mut r.stdin, &note);
        }
    }

    /// Stop the CLI (the app is closing, or the person signed out).
    pub fn stop(&self) {
        if let Some(mut r) = self.running.lock().unwrap().take() {
            let _ = r.child.kill();
            let _ = r.child.wait();
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
}
