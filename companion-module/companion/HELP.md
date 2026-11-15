## GRP Stage Timer

1. On the timer machine, open **Settings → Network control** (called *Companion control* before 1.0.18) and tick **Allow control over the network**. It shows the IP address and port (4800).
2. Put that IP address and port into this connection.

**Presets** (drag onto buttons): Transport, Stage, Cues 1–12, Quick timers, Display only.

**Rules (same as the timer's own buttons):**
- *Cue by number → Select* and *Next / Previous* only select a cue while a timer is running (amber). *Go* puts it live.
- *Cue by number → Go live and start now* is the same as the cue's ▶ button.
- *Quick timer* always replaces what's live.

**Variables:** `time`, `status`, `cue_name`, `next_name`, `picked_name`, `message`, `time_of_day`, `cue_N_name`, `cue_N_length`.

**Feedback:** *Timer colour* colours a button green / amber / red with the stage colours.
