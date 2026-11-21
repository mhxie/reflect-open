import type { Commands as SharedCommands } from './wire.gen.ts'

/**
 * This fork's desktop commands: Tauri commands in `apps/tauri` that the shared
 * command table (`crates/types/src/commands.rs`) does not list, because their
 * arguments and results are not shared with the Swift shell.
 */
export type ForkDesktopCommand =
  | 'activity_begin'
  | 'activity_end'
  | 'search_ipc_start'
  | 'search_ipc_stop'
  | 'search_ipc_respond'
  | 'note_read_for_device'
  | 'asset_read_for_device'
  | 'asset_ocr_cache_read'
  | 'wiki_trust_report_read'
  | 'asset_ocr_cache_keys'
  | 'asset_ocr_cache_write'
  | 'pdf_page_read_for_device'
  | 'pdf_info_for_device'
  | 'asset_ocr_supported'
  | 'pdf_info'
  | 'note_recovery_write'
  | 'note_recovery_read'
  | 'note_recovery_clear'
  | 'local_transcription_status'
  | 'local_transcription_download'
  | 'local_transcription_delete'
  | 'local_transcription_transcribe'
  | 'local_transcription_check_updates'
  | 'local_transcription_skip_update'
  | 'recorder_status'
  | 'recorder_start'
  | 'recorder_stop'
  | 'recorder_cancel'
  | 'recorder_sessions'
  | 'recorder_transcribe'
  | 'recorder_archive'
  | 'recorder_configure'
  | 'on_device_http_send'
  | 'on_device_http_read'
  | 'on_device_http_cancel'
  | 'dev_search_eval_poll'
  | 'dev_search_eval_finish'

/**
 * Every command the frontend may invoke: the generated table, plus this fork's
 * desktop commands. A desktop command's result is `unknown` here, so its
 * caller passes the schema that validates it.
 */
export type Commands = SharedCommands & {
  [Command in ForkDesktopCommand]: { args: Record<string, unknown>; result: unknown }
}
