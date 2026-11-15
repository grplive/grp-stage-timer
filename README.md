# GRP Stage Timer

A clean, reliable stage countdown timer for events, from [GRP Live](https://grp.live).

- Full-screen output on one or more displays, built to sit in a vision-mixer PiP
- Running order with time-of-day cues and a live "running late / ahead" schedule
- Messages to the stage, flash, blackout, time of day
- Control from the keyboard, or from Bitfocus Companion and a Stream Deck

## Download

| | |
|---|---|
| **Mac – Apple Silicon** (M1 and later) | [GRP-Stage-Timer-Mac-Apple-Silicon.dmg](https://github.com/grplive/grp-stage-timer/releases/latest/download/GRP-Stage-Timer-Mac-Apple-Silicon.dmg) |
| **Mac – Intel** | [GRP-Stage-Timer-Mac-Intel.dmg](https://github.com/grplive/grp-stage-timer/releases/latest/download/GRP-Stage-Timer-Mac-Intel.dmg) |
| **Windows** (64-bit) | [GRP-Stage-Timer-Windows-Setup.exe](https://github.com/grplive/grp-stage-timer/releases/latest/download/GRP-Stage-Timer-Windows-Setup.exe) |

Not sure which Mac? Apple menu → About This Mac: "Chip: Apple M…" is Apple Silicon, "Processor: Intel" is Intel.

Older versions and release notes: [Releases](https://github.com/grplive/grp-stage-timer/releases).

### First time you open it

The app isn't signed with Apple or Microsoft yet, so the first launch needs one extra step:

- **Mac:** open the .dmg and drag GRP Stage Timer to Applications, then open it. When macOS says it
  can't verify the app, click **Done**. Go to **System Settings → Privacy & Security**, scroll down
  and click **Open Anyway**. You only do this once.
- **Windows:** if "Windows protected your PC" appears, click **More info → Run anyway**.

Updating: install the new version over the top. Your shows and settings are kept. From 1.0.18 the
timer shows an **Update available** button when a new version is out.

## GRP Notes

Show the presenter's notes on a confidence monitor, with this timer's countdown, colours and messages:
[GRP Notes](https://github.com/grplive/grp-notes). Turn on **Settings → Network control** in the timer.

## Bitfocus Companion

The GRP Stage Timer module comes with the timer rather than through Companion's built-in module list.

1. Download [GRP-Stage-Timer-Companion-Module.tgz](https://github.com/grplive/grp-stage-timer/releases/latest/download/GRP-Stage-Timer-Companion-Module.tgz)
   onto the machine running Companion (version 4 or newer).
2. In Companion, go to Modules → **Import module package** and choose the .tgz.
3. In the timer, turn on **Settings → Network control**, then add a **GRP Stage Timer** connection
   in Companion and enter the IP address the timer shows.

Presets cover transport, cues, quick timers, messages and a live stage preview.
For a newer module, download the latest .tgz and import it again.

## Network API (for Companion and other control systems)

Turn on **Settings → Network control** in the timer (called *Companion control* before 1.0.18). It then listens for HTTP on **port 4800**
(GET or POST, no authentication, local network only).

| Path | Does |
|---|---|
| `/api/state` | JSON: status, display time, cue list, colours, schedule, message, blackout… |
| `/api/toggle` · `/api/start` · `/api/pause` · `/api/go` · `/api/reset` | Transport |
| `/api/next` · `/api/prev` · `/api/cue/3` · `/api/cue/3/go` | Running order (select / go live) |
| `/api/adjust/60` · `/api/adjust/-60` | Add / take off seconds |
| `/api/quick/5` (`1:30`, `90s`; `?start=1`) | Quick timer |
| `/api/message?text=Wrap%20up&mode=full&flash=1` · `/api/message/clear` | Stage messages |
| `/api/flash` · `/api/flash/off` · `/api/blackout[/on\|/off]` · `/api/clock[/on\|/off]` | Stage |

Every command returns `{"ok":true}` or `{"ok":false,"error":"…"}`.

## Help

Questions or problems: [grp.live](https://grp.live).

© GRP Live. Free to download and use.
