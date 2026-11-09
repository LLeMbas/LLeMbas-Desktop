//! Native notifications: a reply finished, or an agent chat's work did, while the person was not
//! looking at it; and a scheduled task has a result the server decided to tell of. The app's own,
//! so the server's Web Push can stay off.
//!
//! The app asks the server's chat list (`/api/v2/chats`) every `EVERY` and notes which chats are
//! being answered; a chat that was and no longer is has finished. The notification is shown
//! unless that chat is open in a window in front. Its words come from the page (`set_words`), in
//! the page's language; the chat's title is the person's own. Nothing from the reply itself is
//! put on screen outside the app.
//!
//! Scheduled tasks: the app follows the server's own event stream (`GET /api/v2/events`), whose
//! `schedules` frame carries the whole list (`{"version", "schedules": [schedule]}`) whenever it
//! changes -- a run starting, waiting, finishing. A schedule's last run that has newly finished is
//! told by the server's notify decision for it: `notified` when the server already told a device,
//! else the schedule's `notify` policy as the server applies it (`services/schedule/notify.py`:
//! `always` -- a result, even "nothing to report"; `matters` -- a result, never a `[SILENT]` one;
//! `never` -- nothing), and a failure the first time in a row and again on the third, which asks
//! whether to pause it. Said by the schedule's title, never the result's words. A server without
//! the stream answers 404, and nothing is said.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Deserialize;
use serde_json::Value;

pub const EVERY: Duration = Duration::from_secs(15);

/// What a notification says, in the page's language.
#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct Words {
    /// A chat's reply is ready.
    pub reply: String,
    /// An agent chat has finished its work.
    pub agent: String,
    /// A scheduled task has a result.
    #[serde(default = "scheduled_word")]
    pub scheduled: String,
    /// A scheduled task's run failed.
    #[serde(default = "scheduled_failed_word")]
    pub scheduled_failed: String,
    /// A scheduled task failed three times in a row: pause it?
    #[serde(default = "scheduled_pause_word")]
    pub scheduled_pause: String,
}

fn scheduled_word() -> String {
    "A scheduled task has a result.".into()
}

fn scheduled_failed_word() -> String {
    "A scheduled task failed.".into()
}

fn scheduled_pause_word() -> String {
    "A scheduled task failed 3 times in a row. Pause it?".into()
}

impl Default for Words {
    fn default() -> Self {
        Words {
            reply: "The reply is ready.".into(),
            agent: "The agent has finished.".into(),
            scheduled: scheduled_word(),
            scheduled_failed: scheduled_failed_word(),
            scheduled_pause: scheduled_pause_word(),
        }
    }
}

/// A chat that has just finished.
#[derive(Clone, Debug, PartialEq)]
pub struct Done {
    pub id: String,
    pub title: String,
    pub agent: bool,
}

#[derive(Default)]
pub struct Watch {
    /// The chat the page shows, if any.
    pub open: Mutex<Option<String>>,
    pub words: Mutex<Words>,
    /// Which chats were being answered at the last look (None before the first look).
    running: Mutex<Option<HashMap<String, bool>>>,
    /// Each schedule's last run at the last look, and whether it had finished (None before the
    /// first look).
    runs: Mutex<Option<HashMap<String, (String, bool)>>>,
    /// Set to end the event stream that is followed now; `reset` sets it and puts a new one here.
    stop: Mutex<Arc<AtomicBool>>,
}

/// How a scheduled task's run is told.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Told {
    /// It has a result.
    Result,
    /// It failed.
    Failed,
    /// It failed for the third time in a row: pause it?
    Pause,
}

/// A scheduled task's newly finished run that is worth telling of.
#[derive(Clone, Debug, PartialEq)]
pub struct Ran {
    pub title: String,
    pub told: Told,
}

/// The run statuses that are an end (`db/models/schedule.py`): `running` and `waiting` are not.
const FINISHED: [&str; 5] = ["ok", "silent", "failed", "skipped", "missed"];
/// The failure in a row that asks whether to pause (`notify.PAUSE_AFTER`).
const PAUSE_AFTER: i64 = 3;

/// Whether a finished run is told, and how: the server's word when it already told (`notified`),
/// else its notify policy for the schedule as the server applies it.
pub fn decide(policy: &str, status: &str, notified: bool, streak: i64) -> Option<Told> {
    let failed = matches!(status, "failed" | "skipped");
    let kind = if failed && streak == PAUSE_AFTER {
        Told::Pause
    } else if failed {
        Told::Failed
    } else {
        Told::Result
    };
    if notified {
        return Some(kind);
    }
    match (policy, status) {
        ("never", _) => None,
        (_, "ok") | ("always", "silent") => Some(Told::Result),
        _ if failed && (streak <= 1 || streak == PAUSE_AFTER) => Some(kind),
        _ => None,
    }
}

impl Watch {
    /// Note the chat list as the server gave it; the chats that finished since the last look.
    /// The first look only notes: what finished before the app looked is not news.
    pub fn look(&self, list: &Value) -> Vec<Done> {
        let rows = list
            .get("chats")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let mut now = HashMap::new();
        let mut done = Vec::new();
        let mut running = self.running.lock().unwrap();
        for row in &rows {
            let Some(id) = row.get("id").and_then(Value::as_str) else {
                continue;
            };
            let busy = row.get("running").and_then(Value::as_bool).unwrap_or(false);
            let was = running
                .as_ref()
                .and_then(|r| r.get(id).copied())
                .unwrap_or(false);
            if was && !busy {
                done.push(Done {
                    id: id.to_string(),
                    title: row
                        .get("title")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string(),
                    agent: row.get("kind").and_then(Value::as_str) == Some("agent"),
                });
            }
            now.insert(id.to_string(), busy);
        }
        *running = Some(now);
        done
    }

    /// Note the schedules as the event stream gave them (`{"schedules": [...]}`); the runs that
    /// finished since the last look and are told. The first look only notes, as with the chats; a
    /// run is told once, however often the list comes again.
    pub fn look_schedules(&self, list: &Value) -> Vec<Ran> {
        let rows = list
            .get("schedules")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let mut seen = self.runs.lock().unwrap();
        let first = seen.is_none();
        let mut now = HashMap::new();
        let mut out = Vec::new();
        for row in &rows {
            let Some(id) = row.get("id").and_then(Value::as_str) else {
                continue;
            };
            let Some(run) = row.get("last_run").filter(|r| r.is_object()) else {
                continue;
            };
            let Some(run_id) = run.get("id").and_then(Value::as_str) else {
                continue;
            };
            let status = run.get("status").and_then(Value::as_str).unwrap_or("");
            let finished = FINISHED.contains(&status);
            let before = seen.as_ref().and_then(|s| s.get(id));
            let known = before.is_some_and(|(r, done)| r == run_id && *done);
            if !first && finished && !known {
                let told = decide(
                    row.get("notify").and_then(Value::as_str).unwrap_or(""),
                    status,
                    run.get("notified").and_then(Value::as_bool) == Some(true),
                    row.get("failure_streak")
                        .and_then(Value::as_i64)
                        .unwrap_or(0),
                );
                if let Some(told) = told {
                    out.push(Ran {
                        title: row
                            .get("title")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string(),
                        told,
                    });
                }
            }
            now.insert(id.to_string(), (run_id.to_string(), finished));
        }
        *seen = Some(now);
        out
    }

    /// The flag that ends the event stream followed now.
    pub fn stop_flag(&self) -> Arc<AtomicBool> {
        self.stop.lock().unwrap().clone()
    }

    /// Start again from nothing: another server, or signed out.
    pub fn reset(&self) {
        *self.running.lock().unwrap() = None;
        *self.runs.lock().unwrap() = None;
        let mut stop = self.stop.lock().unwrap();
        stop.store(true, Ordering::SeqCst);
        *stop = Arc::new(AtomicBool::new(false));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// A schedule in a test: its id, notify policy, failure streak, and last run (id, status,
    /// whether the server told of it).
    type Row<'a> = (&'a str, &'a str, i64, Option<(&'a str, &'a str, bool)>);

    fn schedules(rows: &[Row]) -> Value {
        json!({"version": "v", "schedules": rows.iter().map(|(id, notify, streak, run)| json!({
            "id": id, "title": format!("Task {id}"), "notify": notify, "failure_streak": streak,
            "last_run": run.map(|(r, status, told)| json!({"id": r, "status": status, "notified": told})),
        })).collect::<Vec<_>>()})
    }

    fn ran(id: &str, told: Told) -> Ran {
        Ran {
            title: format!("Task {id}"),
            told,
        }
    }

    #[test]
    fn a_finished_run_is_said_once_by_its_policy_and_a_silent_one_only_when_always() {
        let w = Watch::default();
        assert!(w
            .look_schedules(&schedules(&[
                ("a", "matters", 0, Some(("r1", "ok", false))),
                ("b", "always", 0, None)
            ]))
            .is_empty());
        // Running is not news; finishing is, even under the same run id.
        assert!(w
            .look_schedules(&schedules(&[(
                "a",
                "matters",
                0,
                Some(("r2", "running", false))
            )]))
            .is_empty());
        let out = w.look_schedules(&schedules(&[
            ("a", "matters", 0, Some(("r2", "ok", false))),
            ("b", "always", 0, Some(("r3", "silent", false))),
            ("c", "matters", 0, Some(("r4", "silent", false))),
            ("d", "never", 0, Some(("r5", "ok", false))),
        ]));
        assert_eq!(out, vec![ran("a", Told::Result), ran("b", Told::Result)]);
        // The same list again (the server told a device meanwhile): not said twice.
        assert!(w
            .look_schedules(&schedules(&[("a", "matters", 0, Some(("r2", "ok", true)))]))
            .is_empty());
    }

    #[test]
    fn failures_are_said_the_first_time_and_the_third_asks_to_pause() {
        assert_eq!(decide("matters", "failed", false, 1), Some(Told::Failed));
        assert_eq!(decide("matters", "failed", false, 2), None);
        assert_eq!(decide("always", "skipped", false, 3), Some(Told::Pause));
        assert_eq!(decide("never", "failed", false, 1), None);
        assert_eq!(decide("matters", "missed", false, 0), None);
        // The server's own word wins: it told a device.
        assert_eq!(decide("matters", "failed", true, 2), Some(Told::Failed));
        assert_eq!(decide("matters", "silent", true, 0), Some(Told::Result));
    }

    #[test]
    fn a_reset_ends_the_stream_and_starts_quiet() {
        let w = Watch::default();
        let old = w.stop_flag();
        w.look_schedules(&schedules(&[(
            "a",
            "matters",
            0,
            Some(("r1", "running", false)),
        )]));
        w.reset();
        assert!(old.load(Ordering::SeqCst));
        assert!(!w.stop_flag().load(Ordering::SeqCst));
        assert!(w
            .look_schedules(&schedules(&[(
                "a",
                "matters",
                0,
                Some(("r1", "ok", false))
            )]))
            .is_empty());
    }

    fn list(rows: &[(&str, bool, &str)]) -> Value {
        json!({"chats": rows.iter().map(|(id, running, kind)| json!({
            "id": id, "title": format!("Chat {id}"), "running": running, "kind": kind
        })).collect::<Vec<_>>()})
    }

    #[test]
    fn a_chat_that_stops_running_has_finished_and_the_first_look_is_quiet() {
        let w = Watch::default();
        assert!(w
            .look(&list(&[("a", true, "chat"), ("b", false, "agent")]))
            .is_empty());
        assert!(w
            .look(&list(&[("a", true, "chat"), ("b", true, "agent")]))
            .is_empty());
        let done = w.look(&list(&[("a", false, "chat"), ("b", false, "agent")]));
        assert_eq!(
            done,
            vec![
                Done {
                    id: "a".into(),
                    title: "Chat a".into(),
                    agent: false
                },
                Done {
                    id: "b".into(),
                    title: "Chat b".into(),
                    agent: true
                },
            ]
        );
        // Said once.
        assert!(w.look(&list(&[("a", false, "chat")])).is_empty());
        w.reset();
        assert!(w.look(&list(&[("a", false, "chat")])).is_empty());
    }
}
