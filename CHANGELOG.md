# Changelog

All notable changes to LLeMbas Desktop. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **Reports.** A scheduled task that has something to tell files a report (LLeMbas server
  2.0.0-beta.12), and Reports is where they are read: a row in the sidebar with the number
  unread, the list (the unread first), and a report as a page. Open, it is marked read; it can
  be deleted; **Reply** opens the conversation that continues it -- an ordinary chat, with
  "Report: …" as its title and the way back to Reports, that is in no list of chats. A server
  without reports has no Reports row.
- **A notification comes from a report**, with the report's own title and summary, and opens it.
  A run that merely finished is no longer announced; one that failed still is. A report being
  read in the window in front is not announced. Only a report filed later than any the app has
  seen is news -- reading or deleting the newest does not announce the one before it -- and the
  app remembers that across restarts: what was filed while it was closed is said in one
  notification when it starts, the report itself where it is one, "N new reports" where there
  are more. With a server from before reports (2.0.0-beta.11 and older) a finished run is
  announced as it always was.
- **Scheduled: Notify when.** Every run, When… (with your own condition; the server's default
  stands where you write none) or Never, in place of "Tell me". A task's history says each run's
  own line -- what it found, or that it filed a report -- with the report a press away, what the
  run cost where the server keeps that, and the new state Unchanged (what the task watches is
  as it was: nothing ran).
- **Pages in answers (experimental; off unless the server's administrator switched it on).**
  Where a model adds a page to an answer -- a table, a chart, a layout -- it is shown in its
  place in a sealed frame: a box of one height with the page scrolling inside, and Open larger.
  A page is static everywhere: the server rebuilds it without anything that runs or leads
  anywhere, the app shows exactly that document, in a frame that allows nothing, and never
  draws a model's markup itself. It does look at the document for itself before showing it: one
  in which anything could run or reach somewhere (a script, a link element, an event handler,
  an address in a style, anything written so that it only becomes one when read) is not shown
  at all -- "This page could not be shown safely." -- and neither is one over 2 MiB. While a reply is still being written a page is only its
  title. A page inside a list item or a quotation is drawn there like any other.
  In a long chat frames are made as their place comes into view and let go when it is far. A
  chat's settings have the switch, "Pages in answers", where the server offers it for that chat
  and model. Pages are shown in reports too.
- **A chat says when its Python runs in this window.** Beside the title of a chat on the server:
  "Python runs in this window", once the window really is the chat's page for the `python`
  tool. Where the runner's files could not be made ready it says "Python cannot run in this
  window"; a press gives the reason and Try again. Nothing is said where Python is off on the
  server or the chat is an agent's.

### Fixed

- **A menu row's second word was glued to its first.** The computer menu of a new agent chat
  read "This computerworkbench" and "millmill · linux-x64": the quieter word beside a row's label
  (a computer's host, a folder's whole path, a thinking level) had no style at all. The two are
  on tracks of the row now -- the label left, the hint right, smaller and quieter, each cut
  with an ellipsis where it is too long -- and a computer named after its host says the host
  once. The test suite looks at every menu it opens for this.
- **Menus by the keyboard.** Tab closes a menu and puts the focus back on its button (it used to
  leave the menu hanging open with the focus somewhere in the page); Escape closes it wherever
  the focus is; Home and End go to the first and the last item; a window that changes size
  closes it.
- **A background job's state under a reply being written** is said in the app's language, not
  as the server's raw word.

### Changed

- **A class with no style fails the checks.** `scripts/check-classes.mjs` (run by
  `scripts/check-ui.sh`, so by CI) reads every class the page gives an element and fails for one
  no style sheet has a rule for, unless `scripts/class-hooks.txt` lists it with its reason.

- **A path beside a menu row is cut in its middle, not at its end.** Where a folder's whole path
  does not fit, it is where it is that gives (`/srv/projects/customers…/site`): the last name,
  the part that tells one path from another, stays whole. The whole path is in the tooltip.

- **Scheduled: a task's status and a run's note use the room their row has.** The status in the
  list was cut at a fixed width ("Waiting for the co…") with the row half empty; the list's rows
  now share their tracks and the status is as wide as it says. A run's note takes what the row
  has left, on two lines where one is not enough.

### Removed

- Two controls nothing drew any more (the model picker and the effort control from before the
  chat's chips) and the style rules of six classes nothing used.

## [1.0.0-beta.9] — 2026-11-12

LLeMbas CLI 2.0.0-beta.9 inside, the look and words of LLeMbas 2.0.0-beta.11.

### Changed

- **Where a new agent chat works is one slim bar above the composer**, the same bar the web
  interface has. Computer, folder and mode are three chips of the header's family on one line
  directly above the message box, each opening its menu upward -- no longer split between the
  header's title (computer, folder) and its settings (mode). A long computer name or path gives
  with an ellipsis (the whole of a longer one behind Details); the mode is never cut. Where the bar is
  narrower than 30rem it is one summary chip across it -- "studio · project · Edit" -- that
  opens the three as a column above it, each with its label in front; choosing closes it. The
  computer is always said, also where it is the only one linked. An open agent chat is unchanged:
  its folder and computer beside the title, its mode with the settings.
- **The composer's chips wrap; nothing in it scrolls out of sight.** The chips' line was a
  sideways scroller with its scrollbar hidden. It wraps onto another line now, and a chip wider
  than the line shortens with an ellipsis (checked at 1920, 1280, 1024, 800 and 390 px).

- **A tool call is shown as in every LLeMbas app** (harness specification 3.7.0). One row: a mark
  for its state -- running, done, failed, denied, each told apart at a glance -- an icon for its
  kind, what the tool is called, the call's one short title (the command, the file, the pattern,
  as the server's `block` says it), then the facts from its result: `+3 −1` for an edit, `exit 2`
  for a command that failed, the hits of a search, and how long it took where the server keeps
  it. An edit shows its change without a click, as a diff coloured line by line instead of raw
  text. A failed or denied call says the first line of why beside its title. A tool that is not
  a call (the plan's own) is not drawn; a call still "running" in a reply that has ended is shown
  failed, never left spinning. What you opened stays open while the reply is written.
- **How a reply that did not finish ended stays on it**: `Stopped: by you`, `Stopped: step
  limit`, `Stopped`, or `Failed:` with the error's first line (the whole of a longer one behind Details) --
  one line under the reply, in place of the raw error and "Stopped.".
- **The progress texts and the display rules are the specification's own.** `ui/js/spec.js` is
  written by `scripts/fetch-spec.sh` from the CLI's `harness/loop.json` (3.7.0), with the
  specification's conformance cases beside the tests; the thirteen phase texts are no longer a
  hand-kept copy in the page, and `scripts/gen-i18n.py` reads the sentences to translate from
  that file.

### Added

- **The composer has the `/` and `@` menus.** Typing `/` at the start of the message lists the
  commands: the app's own -- `/help`, `/usage`, `/compact`, `/effort`, `/mode`, `/title`,
  `/terminal`, `/activity`, `/sidebar`, `/theme`, `/image`, `/new`, `/temp`, `/continue`,
  `/stop`, `/devices`, `/scheduled`, each doing what the app's own control does -- and, on an
  agent chat, the computer's own commands and skills, which are sent to it as the message they
  are. Typing `@` after a space lists what can be mentioned: on an agent chat the computer's
  files first (chosen, the path goes into the message as the agent reads it), a web address as
  a page to read, the server's files, and what is already in the chat. **A file on the server
  can be attached this way**: in a chat on the server Enter mentions it by its path and
  Shift+Enter (or the row's button) attaches a copy; in an agent chat it is attached. An
  earlier attachment and a page are attached as the usual tile. Arrows choose, Tab completes,
  Enter runs or attaches, Esc closes; a message that only starts with a slash (`//`, a path, an
  unknown name) is sent as written. The menu is the composer's own width, directly above it, at
  any window width. Needs a server with the menu routes (2.0.0-beta.11); an older one offers
  the app's own commands only.
- **The `python` tool runs in Desktop.** A chat on the server open only in Desktop had no page
  to run Python in, so every `python` call in it failed ("no open browser page is attached to
  this chat"). The window is the chat's page now: while such a chat is shown it says so to the
  server, takes the chat's calls and answers them -- output, last value, errors, and the files a
  call asks to save -- with the same limits as the web page's runner. The code runs in Pyodide
  in a hidden frame of its own, with no way to call the app and no network: the app downloads
  the server's pinned Pyodide files once, checks each one's size and SHA-256 against the
  server's list, and serves them to that frame itself. Needs a server with Python switched on
  and the app's runner routes (2.0.0-beta.11). An agent chat's code runs on its computer, as
  before.
- **The terminal: End shell, the open shells, and connecting again.** The panel has End shell
  (asked first: what runs in it stops). Where the server refuses one more shell, the ones you
  have open are listed -- computer, folder, since when -- each with End. A connection that is
  lost (the network, the server restarting, the link to the computer dropping) is tried again
  by itself after 1, 2, 4, 8, 15 and 30 seconds, counted down, with Reconnect now; when a shell
  opens again it says in one line whether it is the same one or a new one. A shell that exited or sat idle is not
  replaced by itself: New shell is yours to press. Ending and listing shells need a server with
  those routes (2.0.0-beta.11).
- **The Terminal button says why it cannot open.** On an agent chat whose computer is not linked
  right now, or does not open terminals, the button is there, dimmed, and says why and how to
  switch it on (for this computer, with a way straight to the setting). The computers are read
  again every few seconds while it waits, so the button comes alive the moment the computer
  links -- the chat need not be opened again.
- **Approval cards: Deny, and say why.** The four actions every LLeMbas app offers, under the
  same words: Allow once, Always allow, Deny, and Deny, and say why -- your words go to the model
  with the refusal, so it need not ask what you would rather.
- **Question cards: Something else, and asking back.** Under the options (the recommended one
  first) a row of your own to type an answer, and one to ask the model a question back instead of
  answering. Several questions are sent at once; a card that may be put aside has Dismiss.
- **Plan cards: Revise, and the mode the work goes on in.** A device's plan is approved into Edit
  or Manual; Revise sends it back with what to change; Dismiss decides nothing. A plan sent as
  text is drawn as Markdown.
- **Something to do on the phone** is said on a card (confirm it there), and can be declined.

- **A reply ends when it is saved; the chat's name follows.** With server 2.0.0-beta.11 a new
  chat is named by a model after the reply is done: the name arrives on the same stream and the
  header and the sidebar take it, without waiting for the next refresh.

- **A visual pass over every screen** at 1920, 1280, 1024, 800 and 390 px, dark and light: the
  composer's Send sits at the card's edge (a hidden Stop left its gap behind); a scheduled
  task's history has its columns shared by every row, so a status is never cut short and the
  dates line up; at 390 px a scheduled task's name is whole in its header with the buttons under
  it, and Draw a picture is not cut; a model that only thinks or does not says Thinking instead
  of a level's name; a subagent's row in the activity panel has the same room above its name
  as under its last line. The test suite now walks every screen at those sizes in both looks and
  refuses a sideways scroll or a control outside the window or cut off.

### Security

- **One chat's Python never meets another's.** The `python` tool's worker kept its globals and
  the files a call was handed for as long as the app ran, so code run for one chat could read
  what another chat's call had been given. The runner's frame is now thrown away, behind any call
  still running, whenever the window becomes another chat's page or leaves a chat; the next call
  gets a new one, and the frame's own storage is cleared when it starts. Signing out, another
  server or another Pyodide release on the server drop it too, and the app stops serving the
  release it had made ready. A call's value, error and saved files are held to the call's limits
  as its output already was. The window's own page can no longer be taken to the runner's address.
- **What is typed while the terminal reconnects is not sent to a new shell.** Keys typed while a
  lost connection was coming back went to whichever shell answered -- also a new one, where the
  end of a half-typed line would have run alone. They are held until the server says which shell
  it is: the one that was running gets them; for a new one they are dropped, and the panel says
  that what was typed during the reconnect was not sent. Typing ahead of a shell that is being
  opened for the first time works as before.
- **A device's command is sent to the device, never run as one of the app's own**, and a name
  that is not a command's (a space, punctuation) is not offered. Another computer's commands are
  not offered while this one's are being read.

### Fixed

- **The window says it runs a chat's Python only once it can.** It announced itself to the
  server before the runner's files were there, and kept doing so when they could not be fetched:
  calls went to it and timed out, also where a browser tab of the same chat could have run them.
  It is announced when the runner is ready; until then, and where it cannot be made, nothing is
  announced, nothing alarming is shown, and it is tried again more slowly each time.
- **A long reply is not declared lost for being followed again.** Only a stream that gives
  nothing -- closed as it opens -- counts towards "the connection to the reply was lost".
- **The terminal: a shell that answers and drops at once** is tried again after longer each time
  (it was every second, for ever); a window let go for not keeping up waits before it connects
  again; a connection that failed late no longer writes over a newer one's line; End shell ends
  the shell the panel showed when it was asked, found by its computer as well as its folder.
- **The `@` menu: nothing of an earlier lookup can be chosen while a newer one is on its way**;
  Enter then neither picks from the old list nor sends half a mention.
- **Settings marks the last group** when the page is scrolled to its end; the `/` menu's line of
  keys is not shown at a phone's width, where it wrapped and took the list's room.
- **Nothing asks the server again as fast as it answers.** A `python` poll answered with nothing
  at once waits before the next (1 s, doubling to 30 s); an activity stream that closes as soon as
  it opens is opened again more slowly each time; a reply whose stream keeps ending without its
  end is read again three times, then says the connection was lost, with Read again.
- **"Always allow" only where it may be.** An approval the server says can only be allowed once
  (`always: false`) offers Allow once, Deny and Deny, and say why.
- **The calls running right now are drawn while a reply is written** (the stream's `tail.calls`),
  as finished ones are; a call's time is the server's own word for it. A failed reply's whole
  error is behind Details under its last line, not in a tooltip.
- **The Terminal panel did not open once Settings had been visited.** The switch "Let the server
  open a terminal here" in Settings had the panel's own id, so after Settings was drawn every
  later attempt to show the panel showed or hid that switch instead, and no shell was opened
  until the app was started again.
- **Keys typed while a shell was still being opened were dropped.** They are kept, in order, and
  sent the moment it is open.
- **Typing in the terminal waited on a timer.** The socket's thread looked at what was typed only
  between reads that each waited up to 40 ms; a keystroke wakes it at once now, and its echo is
  read within a few milliseconds while the shell is in use.
- **The terminal's last row and column could be cut off.** Its fit counted the box's padding as
  room; it measures the room inside it now.
- **The title bar at narrow widths**: with the server's address hidden, every item after it moved
  one column to the left -- the window's buttons onto the separator's and the menu's tracks,
  unequal and off the edge -- and at the window's smallest size (360 px) the bar was wider than
  the window, so the whole app scrolled sideways. Every item keeps its track, and the bar fits.
- A question's typed answer was ignored when an option was also picked.
- A menu opened at the window's right edge could reach half a pixel past it.

## [1.0.0-beta.8] — 2026-11-10

LLeMbas CLI 2.0.0-beta.8 inside, the look and words of LLeMbas 2.0.0-beta.10.

### Changed

- **The chat's settings moved to the top right of its header; the composer keeps the message.**
  The model picker, how hard it thinks, the subagents and an agent chat's mode sat as chips inside
  the composer, where with a long model name or every chip on they were cut off and some could not
  be reached. They are now in the chat's header, beside the Terminal, the activity panel, the
  chat's tools and skills (a button of its own now, still in the chat's menu too) and the menu; a
  new agent chat's computer and folder sit beside the title, where an open one says where it
  works. The composer holds only the message's own: the text, attach, Dictate, Draw a picture and
  Send/Stop. Where the header has no room for the settings -- measured, so a long model name
  counts -- they fold behind Chat settings, which opens them as a wrapped row under the header:
  nothing is cut off or drawn over another at any width (checked at 1920, 1280, 1024, 800 and
  390 px with long model names and every chip on).

- **Files, in the web explorer's shape, using the window's width.** Both tabs (This computer and
  Server) are now where you are (crumbs, each part a way back), the folder tree, the list in
  columns -- name with an icon by kind, type, size, changed -- and, on a wide window, the chosen
  file's details with the start of it and Open in the viewer (a double click opens it too). With
  less room the details give way first (a file then opens in the viewer), then the tree, then the
  type and date columns, by the room the page has rather than the window's width; nothing is cut
  off or scrolls the page sideways (checked at 1920, 1280, 1024, 800 and 390 px with a long name).
  The tree and the list share one request per folder.

### Fixed

- **Files › Server showed an empty pane while it waited.** Nothing was drawn until the server's
  listing came back -- no word that it was being read -- and a refusal or a broken answer was said
  only once Rust's read timeout (60 s) had passed; to the person it looked as if there were no
  files at all. Every folder in both trees now says Loading… while it is read; after 8 s it says
  the server has not answered yet and offers Try again (the late answer is still drawn); a
  refusal, an answer that is not a listing, or anything that breaks drawing it is said in its
  place with Try again. Read again while an answer was on its way no longer draws the listing
  twice.

## [1.0.0-beta.7] — 2026-11-10

LLeMbas CLI 2.0.0-beta.7 inside, the look and words of LLeMbas 2.0.0-beta.9.

### Added

- **Archived chats.** Archive chat was one-way: an archived chat left the sidebar and could not be
  found again in the app. Archived, under Files in the sidebar, lists them newest first; each opens
  as any chat does, goes back into the sidebar with Restore chat, or is deleted. An archived chat
  that is open says so in its header, with Restore chat beside it and in its menu.
- **An agent chat on another computer.** A new agent chat could only work on this computer. Where
  the account has another computer linked, a chip before the folder chooses it (this computer is
  the default). Its folder is one its agent chats have worked in, or a path typed in; the Terminal
  before the first message opens there too.
- **Language and theme in Settings.** Under Appearance. The language is the account's, as the
  server says it, unless this computer's or another of the app's nine is chosen (kept in the app;
  the window opens again in it). The theme is the account's, and choosing one saves it there, so
  the web interface and the phone follow; on a server that cannot be told, it is kept in the app.
- **Pinned chats and chat folders.** The sidebar lists the pinned chats first, then the account's
  folders, nested and folded as the server keeps them, then the rest by day. A chat's menu pins
  it and moves it into a folder or a new one; a folder's menu renames it, makes one inside it, or
  deletes it (its chats stay, back in the list). The search line still lists every match.
- **Memory.** A page in the sidebar (and in Ctrl+K) lists what the account's models remember about
  the person, as the web's Settings → Memory does: add a record (into a data group, where there is
  more than one), change it, remove it. A record a model noted says so.
- **Search inside.** Ctrl+K finds more than titles: once two letters are typed it asks the
  server's search, and lists below the titles what it found inside chats, in the file library and
  in memory, each with the words around the match, the match marked. A chat opens, a file opens
  in the viewer, a memory opens the Memory page at it. A server without search finds titles only.
- **The server's files can be changed.** On Files → Server, Upload (files chosen in the system's
  dialog) and New folder work in the home folder, and each folder's menu does the same inside it;
  a file's or folder's menu renames it or moves it to the trash. What the server refuses is said
  in the pane, in its words.
- **A chat's tools and skills.** Tools and skills… in a chat's menu switches the tool families
  (web search among them) and the skills on or off for that chat only, as the web's chat settings
  do, and lists the commands it was told to always allow, with Ask me about these again.
- **Voice.** Dictate, beside Send, records a message and writes down what was said where the
  cursor is, through the server's speech to text; a reply's Read this aloud reads it in the
  account's own voice (without its code), and stops when pressed again. Each shows only where the
  server has it on for the account. The microphone is allowed only right after Dictate is pressed.
- **Draw a picture.** From Ctrl+K, where the server can draw for the account: a prompt and a
  shape, and the picture under it. Only the account's own pictures on its own server are shown.
- **A scheduled task's notification says what it found.** Where the server makes the run's
  notification, it carries the task's name and the result's first lines (or the failure said),
  with Open and Run again (and Pause, when a task has failed three times in a row), labelled in
  the account's language. Open, or a click on the notification, opens the task; Run again and
  Pause do it without opening the window. A chat's notification, clicked, opens that chat.
- **The release your server recommends.** Settings › About names the Desktop release that goes
  with the server's version when it is newer than this one (a beta only to a beta install), with
  a link to its release page.
- **Scheduled tasks on a linked computer.** A task's page says where it runs: on the server, or
  on a computer, in a folder and mode, with how long an approval waits, and whether that computer
  is away or does not accept scheduled work. A run waiting for its computer says so. The form
  offers "Where it runs" where the server can: this computer or another linked one that accepts
  scheduled work, its folder (this computer's agent folder to begin with), mode and wait.
- **A picture as the reply, in a chat.** Where the server draws for the account, a Draw a picture
  switch beside the model asks for the next message's reply to be a picture drawn from it — in a
  new chat (its first message) as in an open one. It goes off once the message is sent.

### Fixed

- **A terminal that ended could come back by itself.** Shown again and ended by the server within
  one frame, the panel opened a new shell in its place; an ended shell is now only said.

## [1.0.0-beta.6] — 2026-11-10

LLeMbas CLI 2.0.0-beta.6 inside, the look and words of LLeMbas 2.0.0-beta.8.

### Fixed

- **Approvals show again.** An agent asking to run a command, edit a file or carry out a plan
  stopped with "Waiting for you to allow bash…" and no card to answer it: drawing the card's
  buttons failed, and the space for it stayed empty. Stopping and asking again gave the same.
  Now the card shows, with the command in the box to correct before it runs (it used to show the
  words "Run a command" there instead), what the model says it is for, why it is asking, and which
  subagent asks when one does. A card already on the screen is kept as it is while the reply goes
  on, so a command being corrected or an option picked is no longer lost when the server sends
  the list again; a card that cannot be drawn says why instead of leaving an empty space.
- **Subagents after they are switched on.** The app read which models a new chat is offered
  subagents on only when it signed in, so subagents switched on (or a model added) on the server
  while the app stayed open in the tray never showed on a new chat until it was restarted. A new
  chat now asks the server again. (An agent chat has no Subagents setting: its subagents run on
  the computer, and the server offers none for it.)

### Added

- **Terminal.** An agent chat has a Terminal panel: a shell on the computer the chat works on, in
  its folder, beside the chat (over it in a narrow window). A new agent chat offers it as soon as
  the folder is chosen, before the first message -- and the chat that message makes carries on in
  the same shell. An open agent chat opens its own from the header, the same shell the web
  interface shows. **Send to chat** puts the selection, or the last command and its output, into
  the message box to read before sending; the panel copies them too, and steps between commands
  where the shell marks them. The terminal and the activity panel take turns beside the chat;
  closing either keeps the shell. Offered where the computer allows a terminal (needs the server's
  2.0.0-beta.8). The app opens the connection itself, with its sign-in: the page never holds it.
  "Continue in a terminal" is now in the chat's menu only.
- **What a reply is doing, the same way everywhere.** The line under a reply being written now
  says it in the words every LLeMbas client uses (harness spec 3.4.0): queued, waiting for a
  model and why, loading it, reading the prompt (with how far), thinking, writing (with its
  speed), running a tool and what it runs, waiting for you, waiting for subagents, compacting,
  retrying (counting down), stopped or failed -- each with how long it has lasted, kept moving
  every second. From a server that sends no such line (before 2.0.0-beta.8), the app shows the
  server's own words as before. In every language the server has.
- **Subagents, the whole tree** (harness spec 3.4.0, needs the server's 2.0.0-beta.8). The
  activity panel shows the main agent and every subagent under the one it reports to: its name and
  id, its position, what it is doing right now, how full its context is, its state, model and
  mode (with what it may ask for), its messages in the room and the last one, how many slots are
  still open, and the ones that ended -- dimmed, with how they ended. Any subagent's conversation
  opens read-only, live while it works and after it ended, and so do its findings; a working one
  can be stopped (it and those under it). An agent chat's tree comes from its computer; while that
  computer is away the panel shows the tree as it last was and says the rest is kept there.
- **Subagents for agent chats.** A new agent chat offers the Subagents setting where the server
  says this computer can run them, and an open agent chat where the server offers it for that
  chat.
- **A subagent's approval names it**: "Subagent parser (s1), reviews the parser, asks:".
- `tests/ui/`: the page under a headless browser against a stand-in for the app's bridge, with
  the server's answers as a table (`node tests/ui/run.mjs`, needs Playwright and a Chromium). CI
  runs it on every push (the `ui` job), with Playwright and its Chromium installed for the run.

## [1.0.0-beta.5] — 2026-11-09

Carries LLeMbas CLI 2.0.0-beta.5 and the look of LLeMbas 2.0.0-beta.7, which the Subagents
setting and the panel's compaction need.

### Changed

- **Subagents**, by that name everywhere. The chip under the message box says **Subagents** with the
  least and the most agents a chat runs ("Subagents 1–4"), and opens one slider with two handles,
  **Min** and **Max**, from 1 to the server's cap -- Min never passes Max, and both move with the
  arrow keys as well. The numbers count the chat's own agent: **1 is the agent alone**, with no
  subagents; Max 4 is the agent and up to 3 subagents. The chip shows where the
  server offers subagents for the chat (for a new chat, for its model), and the most is the
  server's cap. Where the chat's model serves one request at a time, it says that subagents need
  another model, on another server, named in the chat. Subagents work on the chat's own model
  unless you name another one in the chat -- there is no setting for a subagent's model. A
  scheduled task's field is **Subagents** too. Needs LLeMbas 2.0.0-beta.7 for the server's word on
  all of this; with an older one the app guesses as before.
- **The activity panel, reshaped.** A button in the chat's header opens it at any time, and the
  line above the message box shows only while something runs ("3 running · 1 queued · 2
  finished"). An agent chat's **Environment** (its folder, and where it is) comes first. **Context**
  says how far it is to the automatic compaction ("80.6k until auto-compact") beside a **Compact**
  button that summarises the earlier turns now (greyed while there is nothing to summarise). **Background tasks** lists subagents, a team's
  members and background commands under **Running**, each with how long it has run and a stop
  square, unfolding to what it is, its latest step, what it is writing and its conversation; the
  tasks under one fold beneath it ("Tasks: 2"), and the finished ones fold away under **Finished**.
  The team's **Room** and the **Plan** have sections of their own.

## [1.0.0-beta.4] — 2026-11-09

Carries LLeMbas CLI 2.0.0-beta.3 and the look of LLeMbas 2.0.0-beta.6. Scheduled tasks need LLeMbas
2.0.0-beta.6 or later.

### Fixed

- **An agent that could not link now gets its link.** Signing in asked the server for the agent's
  token only when the built-in LLeMbas CLI had no login for that server on file -- so a computer
  with an old login the server no longer takes got the app's own token alone, and the agent stayed
  refused. The sign-in now asks for the agent's token unless the agent's link works right now, and
  the CLI's new login replaces the old one. **Link this computer** (and **Link again**) is now its
  own approval for the agent's token, handed to the CLI the same way; before, it ran the CLI's own
  login, which for a server it was logged in to only refreshed the login it had.
- **"Refused" means the server refused**, and says the server's reason. A service that stopped for
  want of a login says *not linked*; any other reason, *stopped* with the reason.

### Changed

- **A new look, the shape of an AI desktop app.** A slim sidebar: **New chat**, a search line,
  **Scheduled**, **Files**, then your chats of both kinds -- agent chats and chats on the server --
  under *Today* and *Earlier*, an agent chat with its folder's name; **Settings** with your account
  at the foot. The sidebar folds away (its button in the title bar, or Ctrl+B) and is a drawer on a
  narrow window.
- **A new chat is a chat page.** A greeting, the choice of **Agent** (on this computer) or **Chat**
  (on the server), and the message box ready -- no form. What the chat starts with sits under the
  text as small chips, each opening a menu: the folder and the mode for an agent chat, the model
  with its picture, how hard it thinks (as the model offers it), and the team's size where a team
  is offered. An open chat has the same chips, and changing one changes the chat.
- **The conversation** in a centred column: your messages in bubbles on the right, with attached
  pictures as thumbnails and other files as tiles; replies full width; thinking and each tool call
  a compact row that unfolds. **Send** is a round button that **Stop** replaces while a reply is
  written.
- **The activity panel** opens from a chip above the message box, on every open chat; while
  agents work, the chip says what they are doing.
- **The agent's status** is a chip in the title bar that opens what the agent says and the one
  thing to do about it. When this computer is not linked -- or the server refused its link -- a
  new agent chat says so right above the message box, with **Link this computer** (or **Link
  again**) there, not only in Settings; while the approval waits, the code to compare is shown
  with Cancel.
- **Files** is a page of its own, with this computer's folders and your files on the server as
  two tabs. **Settings** is grouped -- Account, Agent, Project folders, Notifications, About --
  with the groups listed beside them.

### Added

- **Scheduled tasks** (with a server that has them, LLeMbas 2.0.0-beta.6 or later): the list
  with each task's next run, how its last run went and a switch to pause it, kept up to date as
  the server runs them; a task's page with what it does, when (and in which time zone), its
  model, effort, team and how it tells you, the next runs, and its history -- each run's status,
  time, whether it was late, caught up or run by hand, the model it ran on (and that it switched
  from a busy one), and its result to unfold in place, with its chat to open; earlier runs on
  request. **Run now**, **Edit**, pause and resume, and delete. A new task is said in your own
  words: the server reads them into a rule, a title and an instruction and shows the next five
  runs before you save; the title and instruction can be changed, and where the words give no
  time the days and the time can be set by hand. Each task's settings: when to tell you
  (*when it matters*, *always*, *never*), a new chat for each run or one that grows, its model
  (or the first free one of the scheduling models), its effort and its team. **Models** on the
  list chooses which models scheduled tasks may run on, each shown free or busy.
- **A scheduled task's result comes as a system notification** while the app runs, by the
  task's own setting: a result, never a run with nothing to report unless the task says
  *always*, nothing for *never*; a failure the first time, and on the third in a row the
  question whether to pause it. The app follows the server's event stream for this rather than
  asking every few seconds.

## [1.0.0-beta.3] — 2026-11-09

Carries LLeMbas CLI 2.0.0-beta.3 and the look of LLeMbas 2.0.0-beta.5. Needs a LLeMbas 2.0 server
(2.0.0-beta.5 or later for the activity panel, the Thinking switch and team sizes).

### Added

- **Attachments.** A message can carry files: the attach button beside the composer (the
  system's file dialog), files dropped anywhere on the window, or an image pasted into the
  composer. Each is sent to the server at once and shown above the composer with its size, or
  with the server's reason when it refused it; one taken off before sending is deleted on the
  server. The app sends only files you chose, dropped or pasted -- the page never names a path.
  Agent chats get them too.
- **Edit a message, regenerate a reply, copy either.** Under your messages, *Edit message*
  rewrites one in place and starts the reply again from there (everything after it is dropped,
  as the app says before you save; on the agent's device too); under the last reply,
  *Regenerate reply*. *Copy* puts a message, or a reply's text as Markdown, on the clipboard.
- **The chat's own menu** (⋯ in its header, or a right click on it in the sidebar): rename it,
  open it in the web interface in your browser, archive it, delete it (asked first).
- **Change a chat's model** from its header, and how hard it thinks as the model offers it: a
  model with one level shows nothing to choose; one that can switch thinking off and has one
  effort shows a **Think before answering** switch; more levels keep the selector. A new chat
  starts at the model's own start level, and the control follows the model you pick.
- **Agents, fewest and most**, beside it where the chat can have a team (a chat on the server,
  on a model that serves at least two requests at once, with subagents on): how many agents the
  chat's team may have, its own agent included. Saved at once in the header; on a new chat,
  left empty, your default stands. A pair the server will not take is said in its words, and the
  fields go back.
- **Model pictures**: a model the server has a picture for shows it in the pickers and under
  each reply; the others show their initial on a colour of their own -- the same colour the web
  interface gives them.
- **The activity panel** beside a chat (the header's bolt button, the strip above the message
  box, or the palette): what is in the chat's context, by category, against the model's window;
  the files the chat and its agents wrote, with lines added and removed, each opening in the
  viewer; every background agent -- a team's members as a tree, helpers and commands -- with what
  it was asked, its state, how long it has run, its model, its latest step and what it is
  writing, its whole conversation to read and a button to stop it (a member after you confirm,
  for those under it stop with it); the team's room, who wrote to whom and which messages are
  reports; and the plan. It keeps up by itself while the chat is open. The strip above the
  message box says what the agents are doing ("2 agents working · 1 queued") and opens it. On a
  narrow window the panel covers the chat; at phone width it fills the window.
- **Continue an agent chat in a terminal**: its menu and its header show the command that opens
  the agent's session in a terminal (`lembas -s …`, in the chat's folder), to copy. On this
  computer it names the LLeMbas CLI as it starts here -- the one on your PATH, else the app's own.
- **A command palette** (Ctrl+K): new chats, settings, the agent and updates by name, and every
  chat of both kinds by its title (accents optional). Ctrl+N starts a new chat of the tab you are
  on; Ctrl+, opens the settings.

### Changed

- **The agent's status is the CLI's own word.** The title bar and Settings no longer say
  *running* because a process runs: they say what the built-in LLeMbas CLI says of its link to
  the server -- connecting, running (linked), waiting and why (the server cannot be reached, the
  link dropped, a terminal on this computer holds the link), or refused and why. The same for a
  `lembas service` you run yourself. When the CLI says trying again will not help (the server
  refused this computer's token), the app no longer restarts it every second: it waits until you
  link the computer again. When the agent stops with an error, its last words are the reason
  shown, not just an exit status.

### Fixed

- A Czech sentence in the viewer was in Slovak; "Server files" and the composer's placeholder
  were not translated.

## [1.0.0-beta.2] — 2026-11-07

Carries LLeMbas CLI 2.0.0-beta.2 and the look of LLeMbas 2.0.0-beta.4.

### Changed

- **The agent keeps what its model has read** (LLeMbas CLI 2.0.0-beta.2, harness spec 3.1.0): the
  system prompt is made once per session and sent unchanged, so a local model's server reuses the
  whole conversation instead of reading it again; the date and anything that changes during a
  session come as a short note on your next message; the tools stay the same for the session;
  compaction is the next turn of the same conversation.

### Fixed

- **The editor highlights code again.** One of the editor's modules imported a file the app does
  not have, so every language that parses failed to load and files opened as plain text.

## [1.0.0-beta.1] — 2026-11-03

LLeMbas Desktop 1.0 becomes an app of its own: the agent on this computer by default, your
server's chats, two explorers and a viewer -- no longer a window onto the web interface. It needs a
LLeMbas 2.0 server.


Carries LLeMbas CLI 2.0.0-beta.1. Needs a LLeMbas 2.0 server (2.0.0-beta.1 or later).

### Changed

- **The app's own interface replaces the server's web pages.** The window shows the app's page
  (`ui/`, plain HTML, CSS and JavaScript modules, no build step): the chats, the transcript with
  its steps and tool calls, the reply as it is written, the questions and approvals that wait for
  an answer, and a composer. It talks to the server's `/api/v2`.
- **Agent chats first.** The sidebar opens on agent chats, those on this computer above those on
  your other devices; a new agent chat is started on this computer, in one of the agent's
  folders, with its mode and model. Chats on the server are the second tab.
- **One approval signs the app in and links this computer.** The app asks the server's device
  login for its own token (your chats, as the web interface reads and writes them, and dictation)
  and, in the same approval, for the agent's; the approval opens in your browser. The agent's
  token goes straight to the built-in LLeMbas CLI on its standard input (`lembas login
  --token-stdin`), which keeps it in its own configuration as `lembas login` does; the app never
  stores it. A computer linked already keeps its link, and **Link again** under Settings is still
  there. A server that cannot give both tokens from one approval gets the old two steps.
- The app's own token is not a device: the server lists it under *Apps*, and only the agent's
  link is among the devices an agent chat can start on.
- The look is still the server's: its design tokens, now copied from the 2.0 server, and its
  CodeMirror build for code (`scripts/fetch-vendor.sh`, pinned in `vendor.lock.json`). The
  window takes the account's theme.
- One window with one page: the second webview, and the Linux workaround it needed, are gone. The
  window still has the app's own title bar, and its edges resize it.
- The page's words, old and new, are in all nine of the server's languages.

### Added

- **Two explorers, kept apart**: this computer's -- the open agent chat's folder, or one of the
  agent's folders -- read only inside the agent's folders, and the server's files, through
  `/api/v2/files` with your own access. A server file that is not text, or too large, says so in
  your language instead of failing.
- **A viewer** beside the chat: Markdown drawn, code highlighted (read-only CodeMirror), text,
  and HTML in a sealed frame on its own address, with no access to the app, no network and no way
  to navigate. A file the agent shows (`show`) opens in it: from this computer for an agent chat
  running here, otherwise as the server keeps it (`/api/v2/chats/…/show`), checked against the
  chat's access when it is opened. A file that is gone, too large or not text says so.
- **Native notifications** when a reply or an agent chat finishes while you are elsewhere (on by
  default; Settings, Notifications).
- **A server older than LLeMbas 2.0 is refused** with a message saying which side to update, and so
  is a server whose app interface is newer than this app knows. What counts is the link protocol
  (3) and the app interface (`app_api` 2), not the server's version number.
- **Settings in the app**: the server and the sign-in, the agent and its folders, notifications
  and updates. There are no admin pages.
- When the app cannot start, it says why in `desktop.log` in its log directory, not only on a
  terminal nobody sees. A missing tray no longer stops it from starting.
- With NVIDIA's own driver, WebKitGTK's DMA-BUF renderer is turned off before the window opens
  (unless you have set `WEBKIT_DISABLE_DMABUF_RENDERER`): that renderer leaves the window blank or
  ends the app there, on Wayland most of all.

### Removed

- The server's web interface in the window, the microphone permission it needed, and the theme
  report the window read from it. The web interface stays in the browser, and as an installable
  web app.

### Fixed

- A release can no longer be quietly replaced under the same version: installing the same version
  again does nothing, so people with the broken copy never got the fix. The release workflow now
  refuses a tag that has a release already, unless it is run by hand to replace it.
- A beta's `.deb` sorts below the release that follows it (`1.0.0~beta.1` before `1.0.0`), so apt
  does not keep a beta over its release.

## [0.7.2] — 2026-10-25

Linking this computer again leaves one device, and LLeMbas CLI 1.5.2 inside.

### Changed

- Carries LLeMbas CLI 1.5.2. Linking this computer again no longer leaves an offline copy of it on
  the server holding its agent chats: the old link is signed out, and a LLeMbas server 1.7.2 or
  later moves its chats to the new one. When the agent cannot connect, its log (`agent.log` in the
  app's log directory) now says why -- a certificate that is not trusted, for instance -- instead
  of only "could not reach the instance".

## [0.7.1] — 2026-10-24

The microphone works, and LLeMbas CLI 1.5.1 inside.

### Fixed

- **Dictation said the microphone was blocked, with no way to allow it.** The server's page asks
  for the microphone, and a webview grants it only if the app answers: WebKitGTK refuses whatever
  it is not answered on, and shows no prompt of its own. Desktop now allows the microphone -- the
  microphone only, and only for the server's page in the content view; a camera or a screen still
  gets the platform's refusal.

### Changed

- Carries LLeMbas CLI 1.5.1: an image counts by its size, so a screenshot no longer makes the
  agent compact.

## [0.7.0] — 2026-10-20

Carries LLeMbas CLI 1.5.0: harness spec 2.0.0 — background work as jobs the person can see,
enter and stop, and subagents that run in the background and talk back.

### Changed

- Carries LLeMbas CLI 1.5.0. The agent on this computer runs subagents in the background, keeps
  every background command and subagent as a job of its session, and reports them to a LLeMbas
  server 1.6.0, which shows them in the chat with Stop and a message box.

## [0.6.0] — 2026-10-20

Carries LLeMbas CLI 1.4.0: harness spec 1.2.0, so the agent's memory, notes and skills are the
same tools as the server's.

### Changed

- Carries LLeMbas CLI 1.4.0. The agent on this computer and a LLeMbas server 1.5.0 now send a
  model the same library tools — `memory`, `note_view`, `note_manage`, `skills_list`,
  `skill_view`, `skill_manage` — whether the agent uses its own library or the server's.

## [0.5.0] — 2026-10-18

Carries LLeMbas CLI 1.3.0: a plan in every agent chat, the instance's instructions and
knowledge scope on the device, Edit and Regenerate on agent chats. The app's look comes from
the server's tokens and follows the page's theme; its own pages speak nine languages.

### Changed

- The app's own pages take their look from the server's `tokens.css`, copied by
  `scripts/fetch-tokens.sh` from a server tag and pinned in `tokens.lock.json` (the script with
  no argument verifies the copy). The hand copy had drifted: `--danger`, `--control-h` and
  `--text-xl` were not the server's. The pages name no colour, size or space of their own, and
  no font is bundled: the font rules are left out of the copy, so the title bar and the
  first-run page are set in the system's monospace face.
- The window's frame is painted in the theme's border colour read out of `tokens.css` at build
  time (`build.rs`), not a value written in Rust, and it changes with the theme.
- The first-run page and the title bar speak the system's language when it is one of the
  server's nine (Czech, German, Spanish, French, Hungarian, Italian, Polish, Slovak; English
  otherwise). `ui/i18n.js` is generated by `scripts/gen-i18n.py`: the sentences the server also
  has are translated as the server translates them, the app's own are in the script.

### Fixed

- The title bar followed the desktop's light or dark setting, not the account's theme, so it
  could be dark over the parchment (Shire) page. It now follows the server page: a script in the
  content view reports the page's theme to the app, which paints the frame, the title bar and
  the first-run page in it and remembers it for the next start. The server's pages still get no
  IPC; the report is a navigation attempt the app reads and refuses.
- The close button's hover colour was a literal white; it is the theme's inverse ink.

## [0.4.0] — 2026-10-14

Carries LLeMbas CLI 1.2.0, whose agent stays linked before any folder is allowed and follows
changes to its folders without a restart.

### Added

- **Project folders**: Settings… (in the title bar's and the tray's menu) lists the folders the
  agent may work in, with *Add folder…* (the system's folder dialog), *Remove*, the most an agent
  chat may do there, and whether the server may open a terminal. Turning the agent on with no
  folder chosen opens this page. Changes go through the bundled CLI (`lembas remote`).
- The server is told it is shown in LLeMbas Desktop and on which computer, so it lists this
  computer's device as **Local**, first.

### Fixed

- The title bar's menu opens under the button, not in the middle of the window.
- The agent no longer shows a green light while it may open no folder: the title bar says
  *agent: no folders*.

## [0.3.0] — 2026-10-14

### Added

- Updates: the app looks for a new release at start and every six hours, shows an **update**
  button in the title bar when there is one, and installs it (the .deb with the system's password
  prompt, an AppImage in place) after checking its signature. The menu can also check by hand.

### Fixed

- On Linux the server's page took only the lower half of the window, under an empty title bar
  area. The title bar is now its fixed height and the page takes the rest; the frame you resize
  the window by is drawn around both.

## [0.2.0] — 2026-10-14

### Added

- The window is LLeMbas's own: a title bar in the LLeMbas look with the server's address, the
  agent's state, a menu (the tray's items, plus Reload) and the window buttons. Closing still keeps
  the app in the tray. The server's pages stay in a view of their own, with no access to the app.

### Fixed

- The app icon is the leaf alone, on a transparent background, instead of a dark square tile.
- The window shows the app's icon instead of a generic one (the window, the menu entry and the
  package now share one name, `llembas-desktop`).
- The package is called `llembas-desktop` (it was `l-le-mbas`) and replaces the old one.
- The bundled LLeMbas CLI is installed in the app's own directory instead of as `/usr/bin/lembas`,
  where it could hide, or be hidden by, a `lembas` installed by hand.
- `SHA256SUMS` on the GitHub release no longer lists itself.

## [0.1.0] — 2026-10-14

The first alpha, for Linux. It carries LLeMbas CLI 1.1.0.

### Added

- The app: the server's web UI in a window of its own, a first-run page to choose the server, and a
  tray menu (open, start and stop the agent, link this computer, change server, quit).
- The agent: the bundled LLeMbas CLI runs as `lembas service` while the app runs, restarted when
  it fails and stopped cleanly on quit. A CLI service already running on the computer is used
  instead of starting a second one.
- Linking: `lembas login --json` with the approval page shown in the window.
- Linux packages (`.deb`, AppImage) built by GitHub Actions from a tag.
