//! The terminal panel's socket: a shell on a linked device, through the server's app door.
//!
//! The server has two WebSockets for an app (`/api/v2`, behind the app's token):
//!
//! - `/chats/{chat}/terminal/ws` -- an agent chat's shell, the one the web page's panel opens
//!   too, so the two share it;
//! - `/devices/{device}/terminal/ws?directory=` -- before the chat exists, on the device and in
//!   the folder a new agent chat has chosen. The chat's first message takes that shell over.
//!
//! Both take `cols` and `rows`. Down: the shell's output as binary frames, and text frames
//! `{"t": "ready" | "closed" | "behind" | "error", ...}`. Up: keystrokes as binary,
//! `{"t": "resize", "cols", "rows"}` as text. A refused token closes with 4401.
//!
//! **The token stays here.** The socket is opened in Rust with `Authorization: Bearer` in the
//! handshake, and the page only ever gets the frames (as `terminal` events) and sends keys,
//! sizes and "close" through commands -- the same rule as every other request the page makes.
//! A page cannot open the socket itself: its content security policy allows it no connection
//! but the bridge.
//!
//! One thread per terminal owns its socket. Blocking sockets, no async runtime of its own: the
//! thread reads what the server has (a read that waits about a millisecond), then waits on the
//! page's queue -- so a keystroke wakes it at once and is on the wire without waiting for a read
//! to time out -- and reads again. How long it waits on the queue before reading again is short
//! while the shell is in use (an echo is seen within a few milliseconds) and long when nothing
//! moves, so an idle terminal costs about what it did.

use std::collections::HashMap;
use std::io::ErrorKind;
use std::net::{TcpStream, ToSocketAddrs};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender, TryRecvError};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{json, Value};
use tungstenite::http::Uri;
use tungstenite::stream::MaybeTlsStream;
use tungstenite::{ClientRequestBuilder, Error as WsError, HandshakeError, Message, WebSocket};

use crate::server::{base64, ApiError};

/// The server's close code for a token it refused (`api/v2/terminal.py`).
pub const CLOSE_UNAUTHORIZED: u16 = 4401;
/// The most one keystroke message may be: the server's own limit (a paste, at most).
pub const MAX_INPUT: usize = 256 * 1024;
/// The longest directory the server takes (`api/terminal.py` `MAX_DIR_CHARS`).
const MAX_DIR: usize = 4096;
/// How long a read waits for the server before the thread turns to the page's queue.
const READ: Duration = Duration::from_millis(1);
/// How long the thread then waits on the page's queue (keys wake it at once) before it reads
/// again: while the shell is in use, and when nothing has moved for `ACTIVE_FOR`.
const WAIT_ACTIVE: Duration = Duration::from_millis(3);
const WAIT_IDLE: Duration = Duration::from_millis(40);
const ACTIVE_FOR: Duration = Duration::from_millis(1500);
/// How long a close waits for the server's answer before the socket is simply dropped.
const CLOSE_WAIT: Duration = Duration::from_secs(2);

type Socket = WebSocket<MaybeTlsStream<TcpStream>>;

/// Where the shell is: an agent chat's, or a device's folder before the chat exists.
#[derive(Clone, Debug, PartialEq)]
pub enum Target {
    Chat(String),
    Device { device: String, directory: String },
}

/// An id as the server makes them (a chat's, a device token's): letters, digits, `-` and `_`.
fn id_ok(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// A query value, percent-encoded: every byte but the unreserved ones (RFC 3986 §2.3).
pub fn encode(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for b in text.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// The socket's address on the app door (`https://host/api/v2` -> `wss://host/api/v2/...`).
pub fn url(app: &str, target: &Target, cols: u16, rows: u16) -> Result<String, ApiError> {
    let door = if let Some(rest) = app.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = app.strip_prefix("http://") {
        format!("ws://{rest}")
    } else {
        return Err(ApiError::new(
            400,
            "The server's address is not http or https.",
        ));
    };
    let cols = cols.clamp(2, 1000);
    let rows = rows.clamp(1, 500);
    match target {
        Target::Chat(chat) => {
            if !id_ok(chat) {
                return Err(ApiError::new(400, "Not a chat."));
            }
            Ok(format!(
                "{door}/chats/{chat}/terminal/ws?cols={cols}&rows={rows}"
            ))
        }
        Target::Device { device, directory } => {
            if !id_ok(device) {
                return Err(ApiError::new(400, "Not a device."));
            }
            let directory = directory.trim();
            if directory.is_empty() || directory.len() > MAX_DIR || directory.contains('\0') {
                return Err(ApiError::new(400, "Not a folder."));
            }
            Ok(format!(
                "{door}/devices/{device}/terminal/ws?directory={}&cols={cols}&rows={rows}",
                encode(directory)
            ))
        }
    }
}

/// What the page asked the socket's thread to do.
pub enum Up {
    Keys(Vec<u8>),
    Resize(u16, u16),
    Close,
}

/// One frame for the page, as the `terminal` event: `output` (the bytes, base64), `control`
/// (the server's JSON), or `end` (how it ended: `{code, reason, status, error}`).
#[derive(Clone, Serialize)]
pub struct Down {
    pub id: u64,
    pub kind: &'static str,
    pub data: Value,
}

/// How a terminal's socket ended. `code` is the close frame's (4401: the token was refused),
/// `status` an HTTP status the handshake was answered with, `error` why it could not connect or
/// broke off.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct End {
    pub code: Option<u16>,
    pub reason: String,
    pub status: Option<u16>,
    pub error: Option<String>,
}

impl End {
    fn failed(error: impl Into<String>) -> Self {
        End {
            error: Some(error.into()),
            ..End::default()
        }
    }

    /// The server refused the app's token: the page signs in again.
    pub fn unauthorized(&self) -> bool {
        self.code == Some(CLOSE_UNAUTHORIZED) || self.status == Some(401)
    }
}

/// The open terminals: what each one's thread listens to.
#[derive(Default)]
pub struct Sessions {
    next: AtomicU64,
    open: Mutex<HashMap<u64, Sender<Up>>>,
}

impl Sessions {
    /// Open a terminal's socket on its own thread. `emit` gets every frame, the `end` last;
    /// `ended` is told how it ended just before. The id is the page's handle on it.
    pub fn open(
        &self,
        url: String,
        token: String,
        emit: impl Fn(Down) + Send + 'static,
        ended: impl FnOnce(u64, &End) + Send + 'static,
    ) -> u64 {
        let id = self.next.fetch_add(1, Ordering::SeqCst) + 1;
        let (tx, rx) = mpsc::channel();
        self.open.lock().unwrap().insert(id, tx);
        std::thread::spawn(move || {
            let send = |kind: &'static str, data: Value| emit(Down { id, kind, data });
            let end = run(&url, &token, &rx, &send);
            ended(id, &end);
            send("end", serde_json::to_value(&end).unwrap_or(Value::Null));
        });
        id
    }

    /// Hand the page's keys, size or close to the terminal's thread. False: no such terminal.
    pub fn send(&self, id: u64, up: Up) -> bool {
        self.open
            .lock()
            .unwrap()
            .get(&id)
            .is_some_and(|tx| tx.send(up).is_ok())
    }

    /// Close one terminal (the page's panel let go of it).
    pub fn close(&self, id: u64) {
        if let Some(tx) = self.open.lock().unwrap().remove(&id) {
            let _ = tx.send(Up::Close);
        }
    }

    /// A terminal's thread has ended: forget it.
    pub fn forget(&self, id: u64) {
        self.open.lock().unwrap().remove(&id);
    }

    /// Every terminal closed (signed out, or another server chosen).
    pub fn close_all(&self) {
        for (_, tx) in self.open.lock().unwrap().drain() {
            let _ = tx.send(Up::Close);
        }
    }
}

/// The TCP socket under the WebSocket, to set its read timeout.
fn tcp(ws: &Socket) -> Option<&TcpStream> {
    match ws.get_ref() {
        MaybeTlsStream::Plain(s) => Some(s),
        MaybeTlsStream::Rustls(s) => Some(s.get_ref()),
        _ => None,
    }
}

fn connect(url: &str, token: &str) -> Result<Socket, End> {
    let uri: Uri = url
        .parse()
        .map_err(|e| End::failed(format!("Not an address: {e}")))?;
    let host = uri
        .host()
        .ok_or_else(|| End::failed("The address has no host."))?
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_string();
    let port = uri
        .port_u16()
        .unwrap_or(if uri.scheme_str() == Some("wss") {
            443
        } else {
            80
        });
    let addrs = (host.as_str(), port)
        .to_socket_addrs()
        .map_err(|e| End::failed(format!("Could not reach the server: {e}")))?;
    let mut last = String::from("no address");
    let mut stream = None;
    for addr in addrs {
        match TcpStream::connect_timeout(&addr, Duration::from_secs(10)) {
            Ok(s) => {
                stream = Some(s);
                break;
            }
            Err(e) => last = e.to_string(),
        }
    }
    let stream =
        stream.ok_or_else(|| End::failed(format!("Could not reach the server: {last}")))?;
    // The handshake may take its time; reads only poll once it is done.
    let _ = stream.set_read_timeout(Some(Duration::from_secs(30)));
    let _ = stream.set_nodelay(true);
    let request = ClientRequestBuilder::new(uri)
        .with_header("Authorization", format!("Bearer {token}"))
        .with_header(
            "User-Agent",
            format!("llembas-desktop/{}", env!("CARGO_PKG_VERSION")),
        );
    match tungstenite::client_tls(request, stream) {
        Ok((ws, _)) => Ok(ws),
        Err(HandshakeError::Failure(WsError::Http(res))) => Err(End {
            status: Some(res.status().as_u16()),
            ..End::default()
        }),
        Err(HandshakeError::Failure(e)) => Err(End::failed(format!("Could not connect: {e}"))),
        Err(HandshakeError::Interrupted(_)) => Err(End::failed("The server did not answer.")),
    }
}

/// How long to wait on the page's queue before reading the socket again, given how long ago
/// anything last went either way: short in use, long when idle.
pub fn wait_for(since_traffic: Duration) -> Duration {
    if since_traffic < ACTIVE_FOR {
        WAIT_ACTIVE
    } else {
        WAIT_IDLE
    }
}

/// What became of one thing the page asked for.
enum Forward {
    Sent,
    Closing,
    Broken(String),
}

/// Send the page's keys or size up the socket, or start closing it.
fn forward(ws: &mut Socket, up: Up) -> Forward {
    let sent = match up {
        Up::Keys(bytes) if bytes.len() <= MAX_INPUT => ws.send(Message::binary(bytes)),
        Up::Keys(_) => Ok(()),
        Up::Resize(cols, rows) => ws.send(Message::text(
            json!({ "t": "resize", "cols": cols, "rows": rows }).to_string(),
        )),
        Up::Close => {
            let _ = ws.close(None);
            return Forward::Closing;
        }
    };
    match sent {
        Err(e) if !idle(&e) => Forward::Broken(e.to_string()),
        _ => Forward::Sent,
    }
}

/// A read that only timed out: nothing came in this poll.
fn idle(e: &WsError) -> bool {
    matches!(e, WsError::Io(io) if matches!(io.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut))
}

fn run(url: &str, token: &str, rx: &Receiver<Up>, send: &dyn Fn(&'static str, Value)) -> End {
    let mut ws = match connect(url, token) {
        Ok(ws) => ws,
        Err(end) => return end,
    };
    match tcp(&ws) {
        Some(s) => {
            let _ = s.set_read_timeout(Some(READ));
        }
        None => return End::failed("An unexpected kind of connection."),
    }
    let mut closed_by_server: Option<(u16, String)> = None;
    let mut closing: Option<Instant> = None;
    // When anything last went up or came down: what `wait_for` reads.
    let mut traffic = Instant::now();
    loop {
        // What the page queued, until the server has said goodbye.
        while closing.is_none() && closed_by_server.is_none() {
            let up = match rx.try_recv() {
                Ok(up) => up,
                Err(TryRecvError::Disconnected) => Up::Close,
                Err(TryRecvError::Empty) => break,
            };
            traffic = Instant::now();
            match forward(&mut ws, up) {
                Forward::Sent => {}
                Forward::Closing => closing = Some(Instant::now()),
                Forward::Broken(e) => return End::failed(format!("The connection broke off: {e}")),
            }
        }
        let mut came = false;
        match ws.read() {
            Ok(Message::Binary(bytes)) => {
                came = true;
                send("output", Value::String(base64(&bytes)));
            }
            Ok(Message::Text(text)) => {
                came = true;
                if let Ok(value) = serde_json::from_str::<Value>(text.as_str()) {
                    send("control", value);
                }
            }
            Ok(Message::Close(frame)) => {
                let (code, reason) = frame
                    .map(|f| (u16::from(f.code), f.reason.as_str().to_string()))
                    .unwrap_or((1005, String::new()));
                closed_by_server = Some((code, reason));
            }
            Ok(_) => {}
            Err(e) if idle(&e) => {
                if closing.is_some_and(|at| at.elapsed() > CLOSE_WAIT) {
                    break;
                }
            }
            Err(WsError::ConnectionClosed) | Err(WsError::AlreadyClosed) => break,
            Err(e) => {
                if closing.is_some() || closed_by_server.is_some() {
                    break;
                }
                return End::failed(format!("The connection broke off: {e}"));
            }
        }
        if came {
            // More may be waiting behind it: read again before waiting on anything.
            traffic = Instant::now();
            continue;
        }
        if closing.is_some() || closed_by_server.is_some() {
            // Only the goodbye is left to read: no queue to wait on, and no spinning either.
            std::thread::sleep(WAIT_ACTIVE);
            continue;
        }
        // Nothing from the server: wait on the page's queue, which a keystroke ends at once.
        let up = match rx.recv_timeout(wait_for(traffic.elapsed())) {
            Ok(up) => up,
            Err(RecvTimeoutError::Timeout) => continue,
            Err(RecvTimeoutError::Disconnected) => Up::Close,
        };
        traffic = Instant::now();
        match forward(&mut ws, up) {
            Forward::Sent => {}
            Forward::Closing => closing = Some(Instant::now()),
            Forward::Broken(e) => return End::failed(format!("The connection broke off: {e}")),
        }
    }
    match closed_by_server {
        Some((code, reason)) => End {
            code: Some(code),
            reason,
            ..End::default()
        },
        None => End::default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_chats_terminal_is_on_the_app_door_with_its_size() {
        let t = Target::Chat("chat_1-a".into());
        assert_eq!(
            url("https://ai.example/api/v2", &t, 80, 24).unwrap(),
            "wss://ai.example/api/v2/chats/chat_1-a/terminal/ws?cols=80&rows=24"
        );
        assert_eq!(
            url("http://ai.example:8080/sub/api/v2", &t, 0, 9999).unwrap(),
            "ws://ai.example:8080/sub/api/v2/chats/chat_1-a/terminal/ws?cols=2&rows=500"
        );
    }

    #[test]
    fn a_terminal_before_the_chat_carries_its_folder_encoded() {
        let t = Target::Device {
            device: "token1".into(),
            directory: " /home/dev/my project&x=1 ".into(),
        };
        assert_eq!(
            url("https://ai.example/api/v2", &t, 100, 30).unwrap(),
            "wss://ai.example/api/v2/devices/token1/terminal/ws?directory=%2Fhome%2Fdev%2Fmy%20project%26x%3D1&cols=100&rows=30"
        );
        assert_eq!(encode("C:\\Users\\Ádám"), "C%3A%5CUsers%5C%C3%81d%C3%A1m");
    }

    #[test]
    fn nothing_but_an_id_and_a_folder_reaches_the_address() {
        let door = "https://ai.example/api/v2";
        for bad in ["", "../me", "a/b", "a?b", "a b", "x#y"] {
            assert!(
                url(door, &Target::Chat(bad.into()), 80, 24).is_err(),
                "{bad}"
            );
            let dev = Target::Device {
                device: bad.into(),
                directory: "/tmp".into(),
            };
            assert!(url(door, &dev, 80, 24).is_err(), "{bad}");
        }
        for dir in ["", "   ", "a\0b"] {
            let dev = Target::Device {
                device: "token1".into(),
                directory: dir.into(),
            };
            assert!(url(door, &dev, 80, 24).is_err(), "{dir:?}");
        }
        assert!(url("ftp://ai.example", &Target::Chat("c".into()), 80, 24).is_err());
    }

    #[test]
    fn a_refused_token_is_told_apart_from_a_dropped_line() {
        let refused = End {
            code: Some(CLOSE_UNAUTHORIZED),
            ..End::default()
        };
        assert!(refused.unauthorized());
        assert!(End {
            status: Some(401),
            ..End::default()
        }
        .unauthorized());
        assert!(!End::failed("reset").unauthorized());
        assert!(!End {
            code: Some(1000),
            ..End::default()
        }
        .unauthorized());
    }

    #[test]
    fn the_queue_is_waited_on_briefly_in_use_and_longer_when_idle() {
        assert_eq!(wait_for(Duration::ZERO), WAIT_ACTIVE);
        assert_eq!(wait_for(ACTIVE_FOR - Duration::from_millis(1)), WAIT_ACTIVE);
        assert_eq!(wait_for(ACTIVE_FOR), WAIT_IDLE);
        assert_eq!(wait_for(Duration::from_secs(3600)), WAIT_IDLE);
        // A read never holds a keystroke back for longer than a blink.
        assert!(READ + WAIT_ACTIVE <= Duration::from_millis(5));
        assert!(WAIT_IDLE <= Duration::from_millis(50));
    }

    /// A server of one socket on this machine that sends back whatever it is sent, until closed.
    fn echo() -> (u16, std::thread::JoinHandle<()>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let thread = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut ws = tungstenite::accept(stream).unwrap();
            loop {
                match ws.read() {
                    Ok(m @ (Message::Binary(_) | Message::Text(_))) => {
                        if ws.send(m).is_err() {
                            break;
                        }
                    }
                    Ok(Message::Close(_)) => {
                        // The goodbye's answer is queued by the read: sent before letting go.
                        let _ = ws.flush();
                        break;
                    }
                    Err(_) => break,
                    Ok(_) => {}
                }
            }
        });
        (port, thread)
    }

    #[test]
    fn keys_go_up_at_once_and_the_shells_output_comes_back_even_after_an_idle_spell() {
        let (port, server) = echo();
        let (tx, rx) = mpsc::channel();
        let (seen_tx, seen_rx) = mpsc::channel::<(&'static str, Value)>();
        let client = std::thread::spawn(move || {
            run(
                &format!("ws://127.0.0.1:{port}/terminal"),
                "token",
                &rx,
                &move |kind, data| {
                    let _ = seen_tx.send((kind, data));
                },
            )
        });
        let within = Duration::from_secs(5);
        // In use: keys queued one after another all arrive, in order.
        for key in ["l", "s", "\n"] {
            tx.send(Up::Keys(key.as_bytes().to_vec())).unwrap();
            let (kind, data) = seen_rx.recv_timeout(within).unwrap();
            assert_eq!(kind, "output");
            assert_eq!(data, Value::String(base64(key.as_bytes())));
        }
        // A size goes up as the server's JSON (the echo sends it back as a control frame).
        tx.send(Up::Resize(100, 30)).unwrap();
        let (kind, data) = seen_rx.recv_timeout(within).unwrap();
        assert_eq!(kind, "control");
        assert_eq!(data, json!({ "t": "resize", "cols": 100, "rows": 30 }));
        // Idle for longer than ACTIVE_FOR: the thread waits on the queue, and a key still wakes
        // it well inside the idle wait -- it does not sit out a read's timeout first.
        std::thread::sleep(ACTIVE_FOR + Duration::from_millis(200));
        let at = Instant::now();
        tx.send(Up::Keys(b"x".to_vec())).unwrap();
        let (kind, _) = seen_rx.recv_timeout(within).unwrap();
        assert_eq!(kind, "output");
        assert!(at.elapsed() < Duration::from_secs(2), "{:?}", at.elapsed());
        // A key too large to be a paste is dropped, and the socket lives on.
        tx.send(Up::Keys(vec![b'a'; MAX_INPUT + 1])).unwrap();
        tx.send(Up::Keys(b"y".to_vec())).unwrap();
        let (_, data) = seen_rx.recv_timeout(within).unwrap();
        assert_eq!(data, Value::String(base64(b"y")));
        // Closed from the page: the thread ends without an error.
        tx.send(Up::Close).unwrap();
        let end = client.join().unwrap();
        assert_eq!(end.error, None);
        assert_eq!(end.status, None);
        server.join().unwrap();
    }

    #[test]
    fn a_page_that_goes_away_closes_its_terminal() {
        let (port, server) = echo();
        let (tx, rx) = mpsc::channel::<Up>();
        let client = std::thread::spawn(move || {
            run(
                &format!("ws://127.0.0.1:{port}/terminal"),
                "token",
                &rx,
                &|_, _| {},
            )
        });
        drop(tx);
        let end = client.join().unwrap();
        assert_eq!(end.error, None);
        server.join().unwrap();
    }

    #[test]
    fn keys_for_a_closed_terminal_go_nowhere() {
        let s = Sessions::default();
        assert!(!s.send(7, Up::Keys(b"ls\n".to_vec())));
        s.close(7);
        s.close_all();
    }
}
