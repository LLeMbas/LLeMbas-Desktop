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
//! whether to pause it. A server that made the run's notification (`run.notification`, server
//! 2.0.0-beta.9) gives its words: the task's name and the result's first lines -- shown here as on
//! an unlocked phone, the desktop being the person's own -- and its actions with their labels in
//! the person's language (`open`, `run_again`, and `pause` on a failure that asks). An older
//! server's run is said by the schedule's title and the page's words, without actions. A server
//! without the stream answers 404, and nothing is said.
//!
//! **A result is told by its report** (server 2.0.0-beta.12, harness spec 3.8.0 `reports.md`): a
//! run that has something to tell files a report, and the stream's `reports` frame says so:
//! `{"unread": n, "newest": report | null}`, where `newest` is the newest **unread** report --
//! so when that one is read or deleted, the frame names an older unread one, which is not news.
//! What is news is a report filed later than any this app has seen: the app keeps that
//! high-water mark (the latest `created`), per account, across restarts (`Settings`). A report
//! later than the mark is announced by its own title and summary -- not while the window in
//! front already shows it. Reports filed while the app was not listening (closed, or the stream
//! down) are said in one notification when it listens again: the one report where there is one,
//! "N new reports" where there are more. An account's first frame ever only sets the mark.
//!
//! A server from before reports sends no such frame, and there a finished run is announced as
//! it always was (`decide` with `reports: false`); with reports, a run that finished is not news
//! and one that failed still is.
//!
//! Every notification shown is remembered by its id (`Notes`), so a click on it or on one of its
//! actions knows which chat or which run it was about.

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
    /// Several reports were filed while the app was not listening; `%(n)s` is how many.
    #[serde(default = "reports_new_word")]
    pub reports_new: String,
}

fn reports_new_word() -> String {
    "%(n)s new reports".into()
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
            reports_new: reports_new_word(),
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
    /// The report the page shows, if any.
    pub open_report: Mutex<Option<String>>,
    /// The latest `created` of any report seen (the account's high-water mark; None for none).
    mark: Mutex<Option<String>>,
    /// Whether the next `reports` frame is the first since the stream was opened.
    first: Mutex<bool>,
    /// Whether this server sends `reports` frames at all (it has Reports).
    reports: AtomicBool,
    /// Set to end the event stream that is followed now; `reset` sets it and puts a new one here.
    stop: Mutex<Arc<AtomicBool>>,
    /// The notifications shown, so a click on one knows what it was about.
    pub notes: Notes,
}

/// How a scheduled task's run is told.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Told {
    /// It has a result (a server from before reports).
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
    pub schedule: String,
    pub run: String,
    /// The server's own words for it (`run.notification.body`): the result's first lines, or the
    /// failure said. None from a server that does not make them.
    pub body: Option<String>,
    /// The actions it offers, `(id, label)`, in the server's order: only those the app can do.
    pub actions: Vec<(String, String)>,
}

/// The actions of a scheduled run's notification the app knows how to do.
pub const RUN_ACTIONS: [&str; 3] = ["open", "run_again", "pause"];

/// The most of a result's first lines a notification carries: the server cuts them already.
const BODY_MAX: usize = 400;

/// The words and actions of a run's own notification (`run.notification`), as far as they are
/// usable: a body without control characters and not too long; actions the app knows, each with
/// its label (the id when the server gave none).
fn run_notification(run: &Value) -> (Option<String>, Vec<(String, String)>) {
    let Some(n) = run.get("notification").filter(|n| n.is_object()) else {
        return (None, Vec::new());
    };
    let body = n
        .get("body")
        .and_then(Value::as_str)
        .map(|b| {
            b.chars()
                .map(|c| if c.is_control() && c != '\n' { ' ' } else { c })
                .take(BODY_MAX)
                .collect::<String>()
                .trim()
                .to_string()
        })
        .filter(|b| !b.is_empty());
    let labels = n.get("labels");
    let actions = n
        .get("actions")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(Value::as_str)
                .filter(|a| RUN_ACTIONS.contains(a))
                .map(|a| {
                    let label = labels
                        .and_then(|l| l.get(a))
                        .and_then(Value::as_str)
                        .filter(|l| !l.trim().is_empty())
                        .unwrap_or(a);
                    (a.to_string(), label.to_string())
                })
                .collect()
        })
        .unwrap_or_default();
    (body, actions)
}

/// What a notification shown was about.
#[derive(Clone, Debug, PartialEq)]
pub enum Note {
    /// A chat whose reply or work finished.
    Chat(String),
    /// A scheduled task's run.
    Run { schedule: String, run: String },
    /// A report a scheduled run filed; "" for several at once (the Reports list).
    Report(String),
}

/// A report newly filed: what its notification says.
#[derive(Clone, Debug, PartialEq)]
pub struct Filed {
    pub id: String,
    pub title: String,
    pub summary: String,
}

/// What a `reports` frame is, as news.
#[derive(Clone, Debug, PartialEq)]
pub enum News {
    /// Nothing to say.
    None,
    /// A report filed while the app was listening: said by itself.
    One(Filed),
    /// The first frame since the app began to listen names a report later than the mark:
    /// something was filed meanwhile. How many is the list's to say (`since` with the mark as it
    /// was); `newest` is the one to name where it is the only one.
    Since { mark: String, newest: Filed },
}

/// How many of `reports` (a list's items) were filed after `mark`.
pub fn since(reports: &Value, mark: &str) -> usize {
    reports
        .get("reports")
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .filter(|r| {
                    r.get("created")
                        .and_then(Value::as_str)
                        .is_some_and(|c| later(c, mark))
                })
                .count()
        })
        .unwrap_or(0)
}

/// Whether the stamp `a` is later than `b`. The server writes every stamp the same way (ISO
/// 8601, UTC, to the second or finer), so they compare as text; an empty mark is before all.
fn later(a: &str, b: &str) -> bool {
    !a.is_empty() && a > b
}

/// The notifications shown, by id: the most recent `NOTES_KEPT`.
#[derive(Default)]
pub struct Notes {
    next: Mutex<i32>,
    by_id: Mutex<HashMap<i32, Note>>,
}

const NOTES_KEPT: i32 = 200;

impl Notes {
    /// Remember a notification about to be shown; its id.
    pub fn add(&self, note: Note) -> i32 {
        let mut next = self.next.lock().unwrap();
        *next = next.checked_add(1).unwrap_or(1);
        let id = *next;
        let mut by_id = self.by_id.lock().unwrap();
        by_id.insert(id, note);
        by_id.retain(|k, _| *k > id - NOTES_KEPT);
        id
    }

    pub fn get(&self, id: i32) -> Option<Note> {
        self.by_id.lock().unwrap().get(&id).cloned()
    }
}

/// The run statuses that are an end (`db/models/schedule.py`): `running` and `waiting` are not.
const FINISHED: [&str; 6] = ["ok", "silent", "unchanged", "failed", "skipped", "missed"];
/// The failure in a row that asks whether to pause (`notify.PAUSE_AFTER`).
const PAUSE_AFTER: i64 = 3;

/// Whether a finished run is told, and how. A failure is said when the server already told a
/// device (`notified`), else by the schedule's policy as the server applies it: the first in a
/// row, and the third, which asks whether to pause. A result is told by the report the run filed
/// (`look_reports`) where the server has reports (`reports`): there a run that merely finished
/// is not news. On a server from before reports it is told as it always was: `notified`, else
/// `always` -- a result, even "nothing to report"; anything but `never` -- a result that is not
/// silent.
pub fn decide(
    policy: &str,
    status: &str,
    notified: bool,
    streak: i64,
    reports: bool,
) -> Option<Told> {
    let failed = matches!(status, "failed" | "skipped");
    if !failed && reports {
        return None;
    }
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
                    self.reports.load(Ordering::SeqCst),
                );
                if let Some(told) = told {
                    let (body, actions) = run_notification(run);
                    out.push(Ran {
                        title: row
                            .get("title")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string(),
                        told,
                        schedule: id.to_string(),
                        run: run_id.to_string(),
                        body,
                        actions,
                    });
                }
            }
            now.insert(id.to_string(), (run_id.to_string(), finished));
        }
        *seen = Some(now);
        out
    }

    /// The stream is opened (again): the mark as it was kept for this account, and the next
    /// `reports` frame is the first. The mark in memory stands where it is later.
    pub fn begin(&self, kept: Option<String>) {
        let mut mark = self.mark.lock().unwrap();
        if let Some(k) = kept {
            if mark.as_deref().is_none_or(|m| later(&k, m)) {
                *mark = Some(k);
            }
        }
        *self.first.lock().unwrap() = true;
        self.reports.store(false, Ordering::SeqCst);
    }

    /// The mark as it stands: what to keep for the account.
    pub fn mark(&self) -> Option<String> {
        self.mark.lock().unwrap().clone()
    }

    /// Note the stream's `reports` frame (`{"unread", "newest": report | null}`, `newest` the
    /// newest *unread* report); what it is as news. Only a report filed later than the mark is:
    /// the frame naming an older unread one, because the newest was read or deleted, says
    /// nothing. The mark moves to the newest seen and never back.
    pub fn look_reports(&self, frame: &Value) -> News {
        self.reports.store(true, Ordering::SeqCst);
        let first = std::mem::replace(&mut *self.first.lock().unwrap(), false);
        let Some(report) = frame.get("newest").filter(|r| r.is_object()) else {
            // Nothing unread; what was filed and read elsewhere meanwhile still moves the mark.
            if let Some(latest) = frame.get("latest_created").and_then(Value::as_str) {
                let mut mark = self.mark.lock().unwrap();
                if mark.as_deref().is_none_or(|m| later(latest, m)) && !latest.is_empty() {
                    *mark = Some(latest.to_string());
                }
            }
            return News::None;
        };
        let text = |key: &str| {
            report
                .get(key)
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_string()
        };
        let (id, created) = (text("id"), text("created"));
        if id.is_empty() || created.is_empty() {
            return News::None;
        }
        // The server's own word for when the newest report of any state was filed
        // (`latest_created`): a report has arrived only when that is later than the mark. A
        // server that does not say it leaves the newest unread one's own stamp.
        let latest = frame
            .get("latest_created")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty());
        let stamp = latest.unwrap_or(&created).to_string();
        let mut mark = self.mark.lock().unwrap();
        let before = mark.clone();
        if before.as_deref().is_some_and(|m| !later(&stamp, m)) {
            return News::None;
        }
        *mark = Some(stamp.clone());
        // The one that arrived is named only where it is the newest unread one: if it was read
        // elsewhere already, there is nothing to tell.
        if created != stamp {
            return News::None;
        }
        let newest = Filed {
            id,
            title: text("title"),
            summary: text("summary"),
        };
        match before {
            // The account's first frame ever: what is there already is not news.
            None => News::None,
            Some(mark) if first => News::Since { mark, newest },
            Some(_) => News::One(newest),
        }
    }

    /// The flag that ends the event stream followed now.
    pub fn stop_flag(&self) -> Arc<AtomicBool> {
        self.stop.lock().unwrap().clone()
    }

    /// Start again from nothing: another server, or signed out.
    pub fn reset(&self) {
        *self.running.lock().unwrap() = None;
        *self.runs.lock().unwrap() = None;
        *self.mark.lock().unwrap() = None;
        *self.first.lock().unwrap() = true;
        self.reports.store(false, Ordering::SeqCst);
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

    fn ran(id: &str, run: &str, told: Told) -> Ran {
        Ran {
            title: format!("Task {id}"),
            told,
            schedule: id.into(),
            run: run.into(),
            body: None,
            actions: vec![],
        }
    }

    #[test]
    fn a_runs_own_notification_gives_its_first_lines_and_the_actions_the_app_can_do() {
        let w = Watch::default();
        let row = |run: Value| {
            json!({"version": "v", "schedules": [{
                "id": "s1", "title": "Waybread check", "notify": "matters", "failure_streak": 3,
                "last_run": run,
            }]})
        };
        w.look_schedules(&row(json!({"id": "r0", "status": "running"})));
        let out = w.look_schedules(&row(json!({"id": "r0", "status": "failed", "notified": true,
            "notification": {"title": "Waybread check", "body": "Failed 3 times\u{7} in a row. Pause it?",
                "actions": ["open", "run_again", "pause", "unknown"],
                "labels": {"open": "Otvoriť", "run_again": "Spustiť znova", "pause": ""}}})));
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].told, Told::Pause);
        assert_eq!(
            (out[0].schedule.as_str(), out[0].run.as_str()),
            ("s1", "r0")
        );
        assert_eq!(
            out[0].body.as_deref(),
            Some("Failed 3 times  in a row. Pause it?")
        );
        assert_eq!(
            out[0].actions,
            vec![
                ("open".to_string(), "Otvoriť".to_string()),
                ("run_again".to_string(), "Spustiť znova".to_string()),
                ("pause".to_string(), "pause".to_string()),
            ]
        );
    }

    #[test]
    fn a_notification_is_found_again_by_its_id() {
        let notes = Notes::default();
        let a = notes.add(Note::Chat("c1".into()));
        let b = notes.add(Note::Run {
            schedule: "s1".into(),
            run: "r1".into(),
        });
        assert_ne!(a, b);
        assert_eq!(notes.get(a), Some(Note::Chat("c1".into())));
        assert_eq!(
            notes.get(b),
            Some(Note::Run {
                schedule: "s1".into(),
                run: "r1".into()
            })
        );
        assert_eq!(notes.get(b + 1), None);
        for _ in 0..NOTES_KEPT {
            notes.add(Note::Chat("x".into()));
        }
        assert_eq!(notes.get(a), None);
    }

    #[test]
    fn with_reports_a_finished_run_is_not_news_and_a_failed_one_is_said_once() {
        let w = Watch::default();
        w.begin(None);
        w.look_reports(&json!({ "unread": 0, "newest": null }));
        assert!(w
            .look_schedules(&schedules(&[
                ("a", "when", 0, Some(("r1", "ok", false))),
                ("b", "always", 0, None)
            ]))
            .is_empty());
        // A result is its report's to tell: finishing well says nothing here, whatever the policy.
        let out = w.look_schedules(&schedules(&[
            ("a", "when", 0, Some(("r2", "ok", true))),
            ("b", "always", 0, Some(("r3", "unchanged", false))),
            ("c", "when", 1, Some(("r4", "failed", false))),
            ("d", "never", 1, Some(("r5", "failed", false))),
        ]));
        assert_eq!(out, vec![ran("c", "r4", Told::Failed)]);
        // The same list again: not said twice.
        assert!(w
            .look_schedules(&schedules(&[(
                "c",
                "when",
                1,
                Some(("r4", "failed", true))
            )]))
            .is_empty());
    }

    #[test]
    fn on_a_server_from_before_reports_a_finished_run_is_said_by_its_policy_as_it_was() {
        // No `reports` frame was ever heard on this stream.
        let w = Watch::default();
        w.begin(None);
        assert!(w
            .look_schedules(&schedules(&[(
                "a",
                "matters",
                0,
                Some(("r1", "ok", false))
            )]))
            .is_empty());
        let out = w.look_schedules(&schedules(&[
            ("a", "matters", 0, Some(("r2", "ok", false))),
            ("b", "always", 0, Some(("r3", "silent", false))),
            ("c", "matters", 0, Some(("r4", "silent", false))),
            ("d", "never", 0, Some(("r5", "ok", false))),
        ]));
        assert_eq!(
            out,
            vec![ran("a", "r2", Told::Result), ran("b", "r3", Told::Result)]
        );
        assert_eq!(
            decide("matters", "silent", true, 0, false),
            Some(Told::Result)
        );
        assert_eq!(decide("matters", "ok", false, 0, true), None);
    }

    #[test]
    fn failures_are_said_the_first_time_and_the_third_asks_to_pause() {
        for reports in [true, false] {
            assert_eq!(
                decide("when", "failed", false, 1, reports),
                Some(Told::Failed)
            );
            assert_eq!(decide("when", "failed", false, 2, reports), None);
            assert_eq!(
                decide("always", "skipped", false, 3, reports),
                Some(Told::Pause)
            );
            assert_eq!(decide("never", "failed", false, 1, reports), None);
            assert_eq!(decide("when", "missed", false, 0, reports), None);
            // The server's own word wins: it told a device.
            assert_eq!(
                decide("when", "failed", true, 2, reports),
                Some(Told::Failed)
            );
        }
    }

    /// A `reports` frame as the server sends it (`api/v2/schedules.py` `reports_frame`): how many
    /// are unread, and the newest *unread* report in the list's shape, or null.
    fn frame(unread: usize, newest: Option<(&str, &str)>) -> Value {
        json!({ "unread": unread, "newest": newest.map(|(id, created)| json!({
            "id": id, "title": format!(" Report {id} "), "summary": "Two of the twelve.", "importance": "normal",
            "schedule": { "id": "sched1", "title": "Waybread check" }, "created": created, "unread": true,
        })) })
    }
    fn filed(id: &str) -> Filed {
        Filed {
            id: id.into(),
            title: format!("Report {id}"),
            summary: "Two of the twelve.".into(),
        }
    }
    const T1: &str = "2026-01-02T03:04:05+00:00";
    const T2: &str = "2026-01-03T03:04:05+00:00";
    const T3: &str = "2026-01-04T03:04:05+00:00";
    const T4: &str = "2026-01-05T03:04:05+00:00";

    #[test]
    fn a_report_is_news_only_when_it_was_filed_later_than_any_seen() {
        // An account's first frame ever: three unread, the newest named. Not news; the mark is set.
        let w = Watch::default();
        w.begin(None);
        assert_eq!(w.look_reports(&frame(3, Some(("rep3", T3)))), News::None);
        assert_eq!(w.mark().as_deref(), Some(T3));
        // The person reads the newest: the frame names the next older unread one. Not news --
        // and again for the one after it, and when none is left.
        assert_eq!(w.look_reports(&frame(2, Some(("rep2", T2)))), News::None);
        assert_eq!(w.look_reports(&frame(1, Some(("rep1", T1)))), News::None);
        assert_eq!(w.look_reports(&frame(0, None)), News::None);
        assert_eq!(w.mark().as_deref(), Some(T3), "the mark never goes back");
        // A report is filed while the app listens: said by itself, once.
        assert_eq!(
            w.look_reports(&frame(1, Some(("rep4", T4)))),
            News::One(filed("rep4"))
        );
        assert_eq!(w.look_reports(&frame(1, Some(("rep4", T4)))), News::None);
        // It is deleted, an older one marked unread again elsewhere: still nothing.
        assert_eq!(w.look_reports(&frame(1, Some(("rep2", T2)))), News::None);
    }

    #[test]
    fn the_servers_latest_created_says_whether_a_report_arrived() {
        let with = |f: Value, latest: Option<&str>| {
            let mut f = f;
            f["latest_created"] = json!(latest);
            f
        };
        let w = Watch::default();
        w.begin(None);
        assert_eq!(
            w.look_reports(&with(frame(2, Some(("rep3", T3))), Some(T3))),
            News::None
        );
        // The newest is read: an older unread one is named, and nothing later was filed.
        assert_eq!(
            w.look_reports(&with(frame(1, Some(("rep2", T2))), Some(T3))),
            News::None
        );
        // A report arrives: later than the mark, and it is the newest unread one.
        assert_eq!(
            w.look_reports(&with(frame(2, Some(("rep4", T4))), Some(T4))),
            News::One(filed("rep4"))
        );
        // One arrives and is read elsewhere before the frame: the mark moves, nothing is told --
        // not the older unread one the frame names, and not that one again later.
        const T5: &str = "2026-01-06T03:04:05+00:00";
        assert_eq!(
            w.look_reports(&with(frame(1, Some(("rep2", T2))), Some(T5))),
            News::None
        );
        assert_eq!(w.mark().as_deref(), Some(T5));
        // Nothing unread at all, but something was filed and read meanwhile.
        const T6: &str = "2026-01-07T03:04:05+00:00";
        assert_eq!(w.look_reports(&with(frame(0, None), Some(T6))), News::None);
        assert_eq!(w.mark().as_deref(), Some(T6));
        // No reports at all yet (`latest_created: null`).
        let fresh = Watch::default();
        fresh.begin(None);
        assert_eq!(fresh.look_reports(&with(frame(0, None), None)), News::None);
        assert_eq!(fresh.mark(), None);
    }

    #[test]
    fn what_was_filed_while_the_app_was_not_listening_is_said_once_when_it_listens_again() {
        // Started again with the mark it kept: nothing new, nothing said.
        let w = Watch::default();
        w.begin(Some(T2.into()));
        assert_eq!(w.look_reports(&frame(1, Some(("rep2", T2)))), News::None);
        // Started again, and reports were filed meanwhile: the first frame says since when.
        let w = Watch::default();
        w.begin(Some(T2.into()));
        assert_eq!(
            w.look_reports(&frame(3, Some(("rep4", T4)))),
            News::Since {
                mark: T2.into(),
                newest: filed("rep4")
            }
        );
        assert_eq!(w.mark().as_deref(), Some(T4));
        // How many: the unread list's items later than the mark as it was.
        let list = json!({ "reports": [{ "id": "rep4", "created": T4 }, { "id": "rep3", "created": T3 }, { "id": "rep2", "created": T2 }, { "id": "rep1", "created": T1 }], "unread": 4 });
        assert_eq!(since(&list, T2), 2);
        assert_eq!(since(&list, T4), 0);
        assert_eq!(since(&json!({}), T1), 0);
        // The stream broke off and is followed again: the same, from the mark in memory.
        w.begin(Some(T2.into()));
        assert_eq!(
            w.mark().as_deref(),
            Some(T4),
            "an older kept mark does not take it back"
        );
        assert_eq!(w.look_reports(&frame(3, Some(("rep4", T4)))), News::None);
        // Another account (a reset): its first frame ever only sets the mark.
        w.reset();
        w.begin(None);
        assert_eq!(w.look_reports(&frame(1, Some(("rep9", T1)))), News::None);
        assert_eq!(w.mark().as_deref(), Some(T1));
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
