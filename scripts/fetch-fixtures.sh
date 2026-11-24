#!/usr/bin/env bash
# Copy the server's /api/v2 contract fixtures that tests/ui reads into tests/ui/fixtures/:
#
#   scripts/fetch-fixtures.sh <server-ref>     (a tag such as v2.0.0-beta.8, or a branch)
#
# The server is a git checkout, LLeMbas beside this repository by default (LEMBAS_SERVER names
# another); the files are read from the ref, not from its working tree. SOURCE records the ref and
# the commit, so the tests say which server they hold the app to. CI has no server checkout: the
# copies are committed.
set -euo pipefail
cd "$(dirname "$0")/.."

SERVER="${LEMBAS_SERVER:-../LLeMbas}"
FROM="tests/fixtures/api_v2"
OUT="tests/ui/fixtures"
FILES="chat_agent.json event_ask.json event_status.json event_status_idle.json event_status_person.json
event_status_stopped.json event_tree.json models_agent.json subagent_findings.json subagent_transcript.json tree.json
me.json folders.json folder.json search.json memories.json memory.json scope.json push_report.json push_schedule_failed.json
apps.json apps_stable.json event_schedules.json schedule.json schedule_on_device.json schedule_run.json chat.json chats_listed.json files_listing.json
event_done.json event_done_title_pending.json event_title.json event_steps.json event_tail.json message_failed.json message_stopped.json
mentions.json mentions_url.json device_commands.json device_files.json attachment_from.json
devices.json terminals.json terminal_ready.json terminal_refused.json
python_state.json python_call.json python_result.json
reports.json report.json report_orphan.json report_reply.json event_reports.json chat_report.json schedules.json schedule_runs.json
page.json step_text_page.json chat_html_pages.json models.json
device_directories.json device_directories_places.json device_directories_cli_too_old.json device_directories_not_linked.json
models_agent_directory.json schedule_run_agentic.json schedule_models.json
file_content.json file_content_withheld.json file_save_conflict.json file_create_exists.json files_copied.json
files_trash.json files_restored.json files_trash_emptied.json file_versions.json files_batch.json
tool_media.json media_job.json media_job_done.json media_job_failed.json media_jobs.json mcp_servers.json
file_node.json file_content_archive.json event_reply.json event_reply_end.json
message_unsure.json message_carried.json message_sent_now.json message_discarded.json
editor.json editor_unset.json
device_fs_listing.json device_fs_content.json device_fs_conflict.json device_fs_batch.json device_fs_written.json
device_fs_roots.json device_fs_no_trash.json device_fs_content_withheld.json device_fs_search.json device_fs_stat.json
event_ask_edit.json message_editor.json tool_media_shown.json"

[ $# -eq 1 ] || { echo "usage: scripts/fetch-fixtures.sh <server-ref>" >&2; exit 2; }
commit="$(git -C "$SERVER" rev-parse --verify --quiet "$1^{commit}")" \
  || { echo "fetch-fixtures: $1 is not a commit in $SERVER" >&2; exit 1; }
mkdir -p "$OUT"
for f in $FILES; do
  git -C "$SERVER" show "$commit:$FROM/$f" > "$OUT/$f" || { echo "fetch-fixtures: $f is not at $1" >&2; exit 1; }
done
printf 'LLeMbas %s (%s) %s\n' "$1" "$commit" "$FROM" > "$OUT/SOURCE"
echo "fetch-fixtures: $(echo $FILES | wc -w) files from LLeMbas $1 (${commit:0:12}) -> $OUT"
