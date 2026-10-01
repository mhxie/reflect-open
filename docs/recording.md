# Recording on the Mac

On macOS 14.2 or later every recording, an audio memo or a call, goes
through one native recorder that captures two channels on one clock: the
microphone ("Me") and everything the Mac plays ("Them"). A two-sided call
therefore needs no speaker detection, because who spoke is which channel the
audio arrived on. Both channels are transcribed on the device and the
transcript becomes a note in `inbox/recordings/`.

What the note is linked as depends on the calendar, not on how the recording
was started: one that overlaps a calendar event is a meeting, linked under the
day's `## Meetings` with the event's attendees; any other recording is a memo,
linked under `## [[Audio memos]]` with a title from its first words. A
recording where only one side spoke reads as plain paragraphs; a conversation
gets timed `Me` and `Them` turns.

Elsewhere nothing changes: iOS records memos with its native microphone
recorder into `audio-memos/`, Windows and Linux (and macOS before 14.2) with
the webview's, and the audio-memo pipeline transcribes those as before,
including ones that sync in from those devices.

## Using it

- **Start and stop** from the sidebar microphone, `Mod-Shift-R` or *Record
  audio* in the palette, a click on the menu bar item (right-click for its
  menu), or the global shortcut (default `Control+Option+Command+M`). The menu
  bar and shortcut work while another app, usually the call, has focus.
- The first recording asks for *System Audio Recording* access; the microphone
  permission is the one audio memos already use.
- Recordings are transcribed with the on-device model chosen under Settings →
  Audio memos (Settings → Recording offers the download when the memo engine
  is the cloud one). The cloud engine serves the other platforms only.

## Pipeline

Raw first, like audio memos: nothing is lost if a later step fails.

1. **Capture** (`apps/desktop/src-tauri/src/recorder/device.rs`). A
   private aggregate device joins the default output device (the clock), the
   default input device, and a global process tap. The realtime IO block mixes
   each side to mono and pushes interleaved frames into a lock-free ring; a
   writer thread converts them to a 16 kHz stereo WAV in the app's data folder
   (`meeting-capture/<session>/part-NNN.wav`). WAV survives a crash: only its
   header's sizes go stale, and the reader takes everything to the end of file.
2. **Watchdog** (`watchdog.rs`), once a second: no frames three seconds in
   rebuilds the capture (a permission prompt still open at start leaves the
   device silent), then warns and keeps retrying every ten seconds; a changed
   default device, a stalled stream, or a writer that hit a disk error starts
   a new part on the current devices; a digitally silent microphone warns;
   five quiet minutes on both sides warns and fifteen stop the recording. A
   stop within a second and a half of the start is a double press, and the
   recording is discarded.
3. **Transcription** (`transcribe.rs`). Per part, the microphone is
   echo-suppressed against the system channel (`echo.rs`: the delay comes from
   an envelope correlation over far-end-active frames, per-band coupling from
   medians, and microphone frames that don't rise above the predicted echo are
   gated); with headphones the channels don't correlate and the microphone
   passes through. Each channel is cut into speech regions by energy
   (`local_transcription/utterances.rs`) and each region goes through the
   on-device model chosen for audio memos: whisper.cpp, which drops text it
   probably invented (its own no-speech test and stock sign-offs such as
   "Thanks for watching" written over music), or Qwen3-ASR, which gets shorter
   regions because their edges are its only timestamps and drops output too
   long for its region. The result is cached per model in staging.
4. **Notes** (`packages/core/src/recordings/reconcile.ts`). Residual echo that
   survived the gate is dropped by text (`dropEchoRepeats`: a Me segment that
   restates overlapping Them speech; short replies are kept), segments merge
   into turns, and the transcript note is written to
   `inbox/recordings/recording-<date>-<time>.md` with the base name as an alias.
   When the calendar integration finds the event the recording overlaps, the
   day's note gets the same line the events panel writes under `## Meetings`
   (attendees resolved by invite email to `#person` notes), then a link to the
   transcript; otherwise the link joins `## [[Audio memos]]`. That link is the
   tombstone: a recording whose link exists is never written again.
5. **Archive.** The parts are encoded into one AAC m4a, written locally,
   copied under a hidden name into the folder chosen in Settings → Meetings
   (the app's data folder by default), renamed into place, and staging is
   cleared. The note's `audio:` field points at it, relative to the graph
   when the folder is inside it.

## Limits

- Devices are fixed per part; a device change costs a fraction of a second.
- Several remote speakers all appear as Them.
- With speakers, quiet near-end speech that overlaps the far end can lose
  syllables to the echo gate.
- Long meetings are transcribed after they end, not live. Transcribing holds
  a part's channels in memory, close to 1 GB for an unbroken hour.
- A one-off event already listed in the day's Meetings section is recognized
  by its title appearing there, so a similar title can suppress the line.
- To compare models or debug labeling on a real recording, run the ignored
  `transcribes_a_real_recording` test with `REFLECT_MEETING_TEST_AUDIO` (a
  capture part or an archived m4a) and `REFLECT_WHISPER_TEST_MODEL`.
