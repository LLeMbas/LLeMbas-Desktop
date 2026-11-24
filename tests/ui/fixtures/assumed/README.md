# Assumed shapes

The files here are **not** copied from the server (`scripts/fetch-fixtures.sh` never writes
this directory). They are this app's reading of parts of the editor round's contract for which
the server had no route or fixture when the workspace was built. Each one is the answer the
tests give for a route the app spells in exactly one place:

| File | Route | Spelled in |
|---|---|---|
| `device_fs_listing.json` | `GET /devices/{id}/fs?path=` | `ui/js/explorer.js` `DEVICE_FILES` |
| `device_fs_content.json` | `GET /devices/{id}/fs/content?path=` | the same |
| `device_fs_conflict.json` | `PUT /devices/{id}/fs/content` answered 409 | the same |
| `device_fs_batch.json` | `POST /devices/{id}/fs/move`, `/copy`, `/delete` | the same |
| `event_ask_edit.json` | the `ask` frame's card for an edit asked in manual mode | `ui/js/chat.js` `editDiffs` |
| `message_editor.json` | the `editor` field of `POST /chats` and `POST /chats/{id}/messages` | `ui/js/chat.js` `withEditor` |

When the server's own fixtures for these exist, they replace these files (through
`scripts/fetch-fixtures.sh`, into the directory above), the three places are changed to match,
and this directory goes.
