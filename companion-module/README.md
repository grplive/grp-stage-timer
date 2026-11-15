# GRP Stage Timer: Companion module

Bitfocus Companion module for **GRP Stage Timer**, a stage countdown timer for Mac and Windows.

Download the timer: https://github.com/grplive/grp-stage-timer/releases/latest

See [HELP.md](./companion/HELP.md) for setup, actions, feedbacks, variables and presets.

The timer exposes a small HTTP API on port 4800 (Settings → Network control; called Companion control before timer 1.0.18). This module polls
`/api/state` and sends commands such as `/api/toggle`, `/api/cue/3/go` and `/api/adjust/60`.

## Development

    npm install
    npm run package    # copies the shared time maths from the app and builds the .tgz

`src/timecalc.js` is copied from the app so countdowns and colour stages match the stage display exactly.
