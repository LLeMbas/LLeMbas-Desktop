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
//! Scheduled tasks: the app asks `/api/v2/schedules` as often, and a schedule whose last run is a
//! new one, with the server's word that it is worth telling (`notified`: its notify policy, and a
//! `[SILENT]` run not), is said once -- by the schedule's title, never the result's words. A
//! server without the routes answers 404, and nothing is said.

use std::collections::HashMap;
use std::sync::Mutex;
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
}

fn scheduled_word() -> String {
    "A scheduled task has a result.".into()
}

fn scheduled_failed_word() -> String {
    "A scheduled task failed.".into()
}

impl Default for Words {
    fn default() -> Self {
        Words {
            reply: "The reply is ready.".into(),
            agent: "The agent has finished.".into(),
            scheduled: scheduled_word(),
            scheduled_failed: scheduled_failed_word(),
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
    /// Each schedule's last run at the last look (None before the first look).
    runs: Mutex<Option<HashMap<String, String>>>,
}

/// A scheduled task's new run that the server says is worth telling of.
#[derive(Clone, Debug, PartialEq)]
pub struct Ran {
    pub title: String,
    pub failed: bool,
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

    /// Note the schedules as the server gave them; the new runs to tell of since the last look.
    /// The first look only notes, as with the chats.
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
            let before = seen.as_ref().and_then(|s| s.get(id));
            let told = run.get("notified").and_then(Value::as_bool) == Some(true);
            if !first && before.map(String::as_str) != Some(run_id) && told {
                out.push(Ran {
                    title: row
                        .get("title")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string(),
                    failed: run.get("status").and_then(Value::as_str) == Some("failed"),
                });
            }
            now.insert(id.to_string(), run_id.to_string());
        }
        *seen = Some(now);
        out
    }

    /// Start again from nothing: another server, or signed out.
    pub fn reset(&self) {
        *self.running.lock().unwrap() = None;
        *self.runs.lock().unwrap() = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn schedules(rows: &[(&str, Option<(&str, &str, bool)>)]) -> Value {
        json!({"schedules": rows.iter().map(|(id, run)| json!({
            "id": id, "title": format!("Task {id}"),
            "last_run": run.map(|(r, status, told)| json!({"id": r, "status": status, "notified": told})),
        })).collect::<Vec<_>>()})
    }

    #[test]
    fn a_new_run_the_server_tells_of_is_said_once_and_a_silent_one_never() {
        let w = Watch::default();
        assert!(w
            .look_schedules(&schedules(&[("a", Some(("r1", "ok", true))), ("b", None)]))
            .is_empty());
        let ran = w.look_schedules(&schedules(&[
            ("a", Some(("r2", "ok", true))),
            ("b", Some(("r3", "silent", false))),
        ]));
        assert_eq!(
            ran,
            vec![Ran {
                title: "Task a".into(),
                failed: false
            }]
        );
        assert!(w
            .look_schedules(&schedules(&[("a", Some(("r2", "ok", true)))]))
            .is_empty());
        let failed = w.look_schedules(&schedules(&[("a", Some(("r4", "failed", true)))]));
        assert!(failed[0].failed);
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
