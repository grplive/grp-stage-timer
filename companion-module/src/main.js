// Bitfocus Companion module for GRP Stage Timer.
// Talks to the timer's built-in HTTP API (Settings → Companion control, port 4800).
const { InstanceBase, InstanceStatus, runEntrypoint, combineRgb, Regex } = require('@companion-module/base')
const T = require('./timecalc') // copied from the app (npm run sync) so times match the stage exactly
const PNG = require('./png')

const POLL_MS = 200
const TICK_MS = 100
const PRESET_CUES = 12
const BLINK_LEAD_MS = 25

const WHITE = combineRgb(255, 255, 255)
const BLACK = combineRgb(0, 0, 0)
const GREY = combineRgb(40, 40, 40)
const GREEN = combineRgb(0, 162, 92)
const AMBER = combineRgb(245, 158, 11)
const RED = combineRgb(220, 38, 38)
const BLUE = combineRgb(37, 99, 235)

const hexToRgb = (h) => {
	const m = /^#?([0-9a-f]{6})$/i.exec(h || '')
	if (!m) return BLACK
	const n = parseInt(m[1], 16)
	return combineRgb((n >> 16) & 255, (n >> 8) & 255, n & 255)
}

const hexRgb = (h) => {
	const m = /^#?([0-9a-f]{6})$/i.exec(h || '')
	const n = m ? parseInt(m[1], 16) : 0
	return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}
const rgbNum = (c) => combineRgb(Math.round(c[0]), Math.round(c[1]), Math.round(c[2]))
// Same black/white choice as the stage (render.js contrastText).
function contrast(rgb) {
	const [r, g, b] = rgb.map((v) => {
		v /= 255
		return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
	})
	const L = 0.2126 * r + 0.7152 * g + 0.0722 * b
	return (L + 0.05) / 0.05 >= 1.05 / (L + 0.05) ? [0, 0, 0] : [255, 255, 255]
}
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t)

const STATUS_TEXT = { empty: 'Empty', idle: 'Ready', running: 'Running', paused: 'Paused', finished: 'Finished' }

class StageTimerInstance extends InstanceBase {
	async init(config) {
		this.config = config
		this.data = null // last /api/state
		this.offset = 0 // timer machine clock − this machine's clock
		this.cueCount = -1
		this.failures = 0
		this.lastVars = {}
		this.setActionDefinitions(this.actions())
		this.setFeedbackDefinitions(this.feedbacks())
		this.defineVariables(0)
		this.setPresetDefinitions(this.presets())
		this.start()
	}

	async destroy() {
		this.stop()
	}

	async configUpdated(config) {
		this.config = config
		this.stop()
		this.data = null
		this.start()
	}

	getConfigFields() {
		return [
			{
				type: 'static-text',
				id: 'info',
				width: 12,
				label: '',
				value: 'On the timer machine, tick Settings → Companion control. It shows the IP address to use here.',
			},
			{
				type: 'textinput',
				id: 'host',
				label: 'Timer machine IP',
				width: 8,
				default: '127.0.0.1',
				regex: Regex.HOSTNAME,
			},
			{ type: 'number', id: 'port', label: 'Port', width: 4, default: 4800, min: 1, max: 65535 },
		]
	}

	base() {
		return `http://${(this.config.host || '127.0.0.1').trim()}:${this.config.port || 4800}/api`
	}

	// ---------------- connection ----------------
	start() {
		this.updateStatus(InstanceStatus.Connecting)
		this.polling = true
		this.poll()
		this.ticker = setInterval(() => this.tick(), TICK_MS)
	}

	stop() {
		this.polling = false
		clearTimeout(this.blinkTimer)
		this.blinkTimer = null
		clearTimeout(this.pollTimer)
		clearInterval(this.ticker)
	}

	async poll() {
		if (!this.polling) return
		try {
			const sent = Date.now()
			const res = await fetch(`${this.base()}/state`, { signal: AbortSignal.timeout(1500) })
			if (!res.ok) throw new Error(`HTTP ${res.status}`)
			const d = await res.json()
			if (d.app !== 'grp-stage-timer') throw new Error('Not a GRP Stage Timer')
			const got = Date.now()
			this.offset = d.now - (sent + got) / 2
			this.data = d
			if (this.failures || !this.ok) this.updateStatus(InstanceStatus.Ok)
			this.ok = true
			this.failures = 0
			if (d.cues.length !== this.cueCount) this.defineVariables(d.cues.length)
			this.tick()
			this.checkFeedbacks()
		} catch (e) {
			this.failures++
			if (this.failures === 3 || (this.ok && this.failures === 1)) {
				this.ok = false
				this.data = null
				this.updateStatus(
					InstanceStatus.ConnectionFailure,
					e.name === 'TimeoutError' ? 'No reply' : 'Timer not reachable – is Companion control ticked?',
				)
				this.log('warn', `Stage Timer: ${e.message || e}`)
				this.tick()
				this.checkFeedbacks()
			}
		}
		if (this.polling) this.pollTimer = setTimeout(() => this.poll(), this.ok ? POLL_MS : 2000)
	}

	async send(path) {
		try {
			const res = await fetch(`${this.base()}/${path}`, { method: 'POST', signal: AbortSignal.timeout(2000) })
			const j = await res.json().catch(() => ({}))
			if (!res.ok || j.ok === false) this.log('warn', `Stage Timer: ${j.error || 'HTTP ' + res.status}`)
			clearTimeout(this.pollTimer)
			this.poll() // show the result straight away
		} catch (e) {
			this.log('error', `Stage Timer: could not send ${path}: ${e.message || e}`)
		}
	}

	// ---------------- live values ----------------
	// Re-works the countdown locally between polls so buttons tick as smoothly as the stage.
	live() {
		const d = this.data
		if (!d) return null
		const now = Date.now() + this.offset
		if (d.status !== 'running' || d.endsAt == null)
			return { rem: d.remainingMs, display: d.display, stage: d.stage, now }
		const rem = d.endsAt - now
		return {
			rem,
			now,
			display: T.formatTimer(rem, d.totalMs, d.timeFormat),
			stage: T.stage(rem, d.totalMs, d.thresholds),
		}
	}

	// Same as the stage (render.js): on for 400 ms, off for 400 ms, on the timer machine's clock.
	// BLINK_LEAD_MS covers Companion's render + Stream Deck write so the key changes with the stage.
	flashPhase() {
		return Math.floor((Date.now() + this.offset + BLINK_LEAD_MS) / 400) % 2 === 0
	}

	// Re-checks the Flash feedback on each 400 ms boundary while flashing.
	blink() {
		this.checkFeedbacks('flashing', 'stage_look')
		if (!this.polling || !this.data || !this.data.flashing) {
			this.blinkTimer = null
			return
		}
		const t = Date.now() + this.offset + BLINK_LEAD_MS
		this.blinkTimer = setTimeout(() => this.blink(), 400 - (t % 400) + 2)
	}

	tick() {
		const d = this.data
		const l = this.live()
		const v = {}
		if (!d || !l) {
			Object.assign(v, {
				schedule_short: '',
				schedule: '',
				schedule_state: '',
				show_end: '',
				cue_end: '',
				stage_main: '--:--',
				time: '--:--',
				status: 'Offline',
				cue_name: '',
				cue_number: '',
				next_name: '',
				next_number: '',
				picked_name: '',
				message: '',
				time_of_day: '',
				stage: '',
			})
		} else {
			Object.assign(v, {
				time: l.display,
				status: STATUS_TEXT[d.status] || d.status,
				stage: l.stage,
				cue_name: d.label || (d.status === 'empty' ? '' : 'Quick timer'),
				cue_number: d.cueNumber ? String(d.cueNumber) : '',
				next_name: d.nextName,
				next_number: d.nextNumber ? String(d.nextNumber) : '',
				picked_name: d.pickedName,
				message: d.message ? d.message.text : '',
				time_of_day: T.formatClock(l.now, this.clockOpts()),
				schedule: (d.schedule && d.schedule.text) || '',
				schedule_state: (d.schedule && d.schedule.state) || '',
				schedule_short: !d.schedule
					? ''
					: d.schedule.state === 'late'
						? '+' + d.schedule.text.replace(/^Running | late$/g, '')
						: d.schedule.state === 'ahead'
							? '−' + d.schedule.text.replace(/ ahead$/, '')
							: d.schedule.state === 'ontime'
								? 'On time'
								: '',
				show_end: (d.schedule && d.schedule.showEnd) || '',
				cue_end: (d.schedule && d.schedule.liveEnd) || '',
			})
			const main = this.stageMain()
			v.stage_main = main === 'msg' ? d.message.text : main === 'clock' ? v.time_of_day : l.display
			for (const c of d.cues) {
				v[`cue_${c.number}_name`] = c.name
				v[`cue_${c.number}_length`] = c.length
			}
		}
		if (d && d.flashing && !this.blinkTimer) this.blink()
		const changed = {}
		for (const k of Object.keys(v)) if (this.lastVars[k] !== v[k]) changed[k] = v[k]
		if (Object.keys(changed).length) {
			Object.assign(this.lastVars, changed)
			this.setVariableValues(changed)
			if ('stage' in changed || 'time' in changed) this.checkFeedbacks('timer_colour', 'stage')
			if ('stage' in changed || 'time' in changed || 'stage_main' in changed) this.checkFeedbacks('stage_look')
		}
	}

	defineVariables(n) {
		this.cueCount = n
		const defs = [
			{ variableId: 'stage_main', name: 'What the stage shows: timer, time of day, or a full-screen message' },
			{ variableId: 'time', name: 'Timer (as on stage)' },
			{ variableId: 'status', name: 'Status (Ready / Running / Paused / Finished)' },
			{ variableId: 'stage', name: 'Colour stage (normal / warn / danger / over)' },
			{ variableId: 'cue_name', name: 'Live cue name' },
			{ variableId: 'cue_number', name: 'Live cue number' },
			{ variableId: 'next_name', name: 'Next cue name (what Next would pick)' },
			{ variableId: 'next_number', name: 'Next cue number' },
			{ variableId: 'picked_name', name: 'Selected (not yet live) cue name' },
			{ variableId: 'message', name: 'Message on stage' },
			{ variableId: 'time_of_day', name: 'Time of day on the timer machine' },
			{ variableId: 'schedule', name: 'Schedule: "Running 3 min late" / "2 min ahead" / "On schedule"' },
			{ variableId: 'schedule_short', name: 'Schedule, short: "+3 min" (late) / "−2 min" (ahead) / "On time"' },
			{ variableId: 'schedule_state', name: 'Schedule state (late / ahead / ontime / none)' },
			{ variableId: 'show_end', name: 'Show ends ≈ (HH:MM)' },
			{ variableId: 'cue_end', name: 'Live cue ends ≈ (HH:MM)' },
		]
		for (let i = 1; i <= Math.max(n, PRESET_CUES); i++) {
			defs.push(
				{ variableId: `cue_${i}_name`, name: `Cue ${i} name` },
				{ variableId: `cue_${i}_length`, name: `Cue ${i} length` },
			)
		}
		this.setVariableDefinitions(defs)
		this.lastVars = {}
		const blank = {}
		for (let i = n + 1; i <= Math.max(n, PRESET_CUES); i++) blank[`cue_${i}_name`] = blank[`cue_${i}_length`] = ''
		this.setVariableValues(blank)
	}

	// ---------------- actions ----------------
	actions() {
		const onOff = (id) => ({
			type: 'dropdown',
			id,
			label: 'Do',
			default: 'toggle',
			choices: [
				{ id: 'toggle', label: 'Toggle' },
				{ id: 'on', label: 'On' },
				{ id: 'off', label: 'Off' },
			],
		})
		const simple = (name, path) => ({ name, options: [], callback: () => this.send(path) })
		return {
			toggle: simple('Start / pause', 'toggle'),
			start: simple('Start', 'start'),
			pause: simple('Pause', 'pause'),
			go: simple('Go (put the selected cue live)', 'go'),
			reset: simple('Reset', 'reset'),
			next: simple('Next cue', 'next'),
			prev: simple('Previous cue', 'prev'),
			cue: {
				name: 'Cue by number',
				options: [
					{ type: 'number', id: 'n', label: 'Cue number', default: 1, min: 1, max: 999 },
					{
						type: 'dropdown',
						id: 'mode',
						label: 'Do',
						default: 'select',
						choices: [
							{ id: 'select', label: 'Select (same as clicking it: loads it, or only selects it while a timer runs)' },
							{ id: 'go', label: 'Go live and start now (same as its ▶)' },
						],
					},
				],
				callback: (e) => this.send(`cue/${e.options.n}${e.options.mode === 'go' ? '/go' : ''}`),
			},
			adjust: {
				name: 'Add / take off time',
				options: [
					{
						type: 'dropdown',
						id: 'dir',
						label: 'Do',
						default: '+',
						choices: [
							{ id: '+', label: 'Add' },
							{ id: '-', label: 'Take off' },
						],
					},
					{ type: 'number', id: 'min', label: 'Minutes', default: 1, min: 0, max: 600 },
					{ type: 'number', id: 'sec', label: 'Seconds', default: 0, min: 0, max: 59 },
				],
				callback: (e) => {
					const s = (Number(e.options.min) || 0) * 60 + (Number(e.options.sec) || 0)
					if (s) this.send(`adjust/${e.options.dir === '-' ? -s : s}`)
				},
			},
			quick: {
				name: 'Quick timer (replaces whatever is live)',
				options: [
					{ type: 'textinput', id: 'len', label: 'Length (5 = 5 min, 1:30, 90s)', default: '5', useVariables: true },
					{ type: 'checkbox', id: 'start', label: 'Start it straight away', default: false },
				],
				callback: async (e, ctx) => {
					const len = String(await ctx.parseVariablesInString(e.options.len)).trim()
					if (len) this.send(`quick/${encodeURIComponent(len)}${e.options.start ? '?start=1' : ''}`)
				},
			},
			message: {
				name: 'Show message',
				options: [
					{ type: 'textinput', id: 'text', label: 'Message', default: 'Please wrap up', useVariables: true },
					{
						type: 'dropdown',
						id: 'mode',
						label: 'Where',
						default: 'under',
						choices: [
							{ id: 'under', label: 'Under the timer' },
							{ id: 'full', label: 'Full screen' },
						],
					},
					{ type: 'checkbox', id: 'flash', label: 'Flash it', default: false },
				],
				callback: async (e, ctx) => {
					const text = await ctx.parseVariablesInString(e.options.text)
					const q = new URLSearchParams({ text, mode: e.options.mode, flash: e.options.flash ? '1' : '0' })
					this.send(`message?${q}`)
				},
			},
			clear_message: simple('Clear message', 'message/clear'),
			flash: {
				name: 'Flash',
				options: [
					{
						type: 'dropdown',
						id: 'do',
						label: 'Do',
						default: 'flash',
						choices: [
							{ id: 'flash', label: 'Flash (press again to stop)' },
							{ id: 'off', label: 'Stop flashing' },
						],
					},
				],
				callback: (e) => this.send(e.options.do === 'off' ? 'flash/off' : 'flash'),
			},
			blackout: {
				name: 'Blackout',
				options: [onOff('do')],
				callback: (e) => this.send(`blackout/${e.options.do === 'toggle' ? '' : e.options.do}`),
			},
			clock: {
				name: 'Time of day',
				options: [onOff('do')],
				callback: (e) => this.send(`clock/${e.options.do === 'toggle' ? '' : e.options.do}`),
			},
		}
	}

	// ---------------- feedbacks ----------------
	feedbacks() {
		const d = () => this.data
		return {
			timer_colour: {
				type: 'advanced',
				name: 'Timer colour (same colours as the stage)',
				description: 'Colours the button like the stage digits: green / amber / red. Grey when nothing is loaded.',
				options: [],
				callback: () => {
					const data = d()
					const l = this.live()
					if (!data || !l || data.status === 'empty') return { bgcolor: GREY, color: WHITE }
					const c = data.colours || {}
					const hex = l.stage === 'warn' ? c.warn : l.stage === 'normal' ? c.normal : c.danger
					const bg = hexToRgb(hex)
					return { bgcolor: bg, color: l.stage === 'warn' ? BLACK : WHITE }
				},
			},
			stage_look: {
				type: 'advanced',
				name: 'Looks like the stage (background, digit colour, progress bar, flash)',
				description:
					'Draws the button the way the stage output looks: same colours, the progress bar if it is switched on, and the flash.',
				options: [],
				callback: (fb) => this.stageLook(fb),
			},
			status: {
				type: 'boolean',
				name: 'Timer status is…',
				defaultStyle: { bgcolor: GREEN, color: WHITE },
				options: [
					{
						type: 'dropdown',
						id: 'status',
						label: 'Status',
						default: 'running',
						choices: Object.entries(STATUS_TEXT).map(([id, label]) => ({ id, label })),
					},
				],
				callback: (f) => !!d() && d().status === f.options.status,
			},
			stage: {
				type: 'boolean',
				name: 'Timer colour stage is…',
				defaultStyle: { bgcolor: RED, color: WHITE },
				options: [
					{
						type: 'dropdown',
						id: 'stage',
						label: 'Stage',
						default: 'danger',
						choices: [
							{ id: 'normal', label: 'Plenty of time' },
							{ id: 'warn', label: 'Warning' },
							{ id: 'danger', label: 'Danger' },
							{ id: 'over', label: 'Over time' },
						],
					},
				],
				callback: (f) => {
					const l = this.live()
					return !!l && d().status !== 'empty' && l.stage === f.options.stage
				},
			},
			cue_live: {
				type: 'boolean',
				name: 'Cue is live',
				defaultStyle: { bgcolor: GREEN, color: WHITE },
				options: [{ type: 'number', id: 'n', label: 'Cue number', default: 1, min: 1, max: 999 }],
				callback: (f) => !!d() && d().cueNumber === Number(f.options.n),
			},
			cue_picked: {
				type: 'boolean',
				name: 'Cue is selected (waiting for Go)',
				defaultStyle: { bgcolor: AMBER, color: BLACK },
				options: [{ type: 'number', id: 'n', label: 'Cue number', default: 1, min: 1, max: 999 }],
				callback: (f) => !!d() && d().pickedNumber === Number(f.options.n),
			},
			picked_any: {
				type: 'boolean',
				name: 'A cue is selected (waiting for Go)',
				defaultStyle: { bgcolor: AMBER, color: BLACK },
				options: [],
				callback: () => !!d() && d().pickedNumber > 0,
			},
			schedule: {
				type: 'boolean',
				name: 'Schedule is…',
				defaultStyle: { bgcolor: AMBER, color: BLACK },
				options: [
					{
						type: 'dropdown',
						id: 'state',
						label: 'State',
						default: 'late',
						choices: [
							{ id: 'late', label: 'Running late' },
							{ id: 'ahead', label: 'Ahead' },
							{ id: 'ontime', label: 'On schedule' },
						],
					},
				],
				callback: (f) => !!d() && !!d().schedule && d().schedule.state === f.options.state,
			},
			blackout: {
				type: 'boolean',
				name: 'Blackout is on',
				defaultStyle: { bgcolor: RED, color: WHITE },
				options: [],
				callback: () => !!d() && d().blackout,
			},
			clock: {
				type: 'boolean',
				name: 'Time of day is on',
				defaultStyle: { bgcolor: BLUE, color: WHITE },
				options: [],
				callback: () => !!d() && d().clock,
			},
			message: {
				type: 'boolean',
				name: 'A message is showing',
				defaultStyle: { bgcolor: BLUE, color: WHITE },
				options: [],
				callback: () => !!d() && !!d().message,
			},
			flashing: {
				type: 'boolean',
				name: 'Flashing (blinks in time with the stage)',
				defaultStyle: { bgcolor: AMBER, color: BLACK },
				options: [],
				callback: () => !!d() && d().flashing && this.flashPhase(),
			},
		}
	}

	// Mirrors render.js: background, digit colour, flash and progress bar.
	// What fills the stage's main slot, same order as render.js: full-screen message, then a
	// replacing time of day, otherwise the timer.
	stageMain() {
		const d = this.data
		const look = (d && d.look) || {}
		if (d && d.message && d.message.mode === 'full') return 'msg'
		if (look.clockReplace) return 'clock'
		return 'timer'
	}

	clockOpts() {
		const look = (this.data && this.data.look) || {}
		return { clock24h: look.clock24h !== false, clockSeconds: look.clockSeconds !== false }
	}

	// Text size for the preview button: 4 digits big, longer times smaller (one line), messages fit.
	previewSize(main) {
		if (main === 'msg') return 'auto'
		const len = String(this.lastVars.stage_main || '').length
		return len <= 5 ? 18 : len <= 8 ? 14 : 'auto'
	}

	stageLook(fb) {
		const d = this.data
		const l = this.live()
		if (!d || !l) return { bgcolor: GREY, color: WHITE }
		const look = d.look || { background: '#000000', colourTarget: 'digits', progressBar: false, flashStyle: 'digits' }
		if (d.blackout) return { bgcolor: BLACK, color: combineRgb(60, 60, 60) } // stage is black; keep the time just readable
		const c = d.colours || {}
		const stg = d.status === 'empty' ? 'normal' : l.stage
		const colour = hexRgb(stg === 'normal' ? c.normal : stg === 'warn' ? c.warn : c.danger)
		const main = this.stageMain()
		const phaseOn = this.flashPhase()
		let bg = hexRgb(look.background)
		let text = main === 'clock' ? [255, 255, 255] : main === 'msg' ? hexRgb(look.messageColour || '#ffffff') : colour
		if (look.colourTarget === 'background' && main === 'timer') {
			bg = colour
			text = contrast(colour)
		}
		const flashOff = d.timerFlash && !phaseOn
		if (flashOff && look.flashStyle === 'screen') {
			bg = main === 'timer' && look.colourTarget !== 'background' ? colour : [255, 255, 255]
			text = contrast(bg)
		}
		// The stage fades only the digits in a "digits" flash; the progress bar keeps its colour.
		const barFill = look.colourTarget === 'background' ? text : colour
		if (flashOff && look.flashStyle !== 'screen' && main !== 'msg') text = mix(bg, text, 0.08)
		if (main === 'msg' && d.messageFlash && !phaseOn) text = mix(bg, text, 0.1) // a flashing message
		const out = { bgcolor: rgbNum(bg), color: rgbNum(text), size: this.previewSize(main) }
		if (main === 'timer' && look.progressBar && d.status !== 'empty' && d.totalMs > 0) {
			const w = (fb.image && fb.image.width) || 72
			const h = (fb.image && fb.image.height) || 72
			const bw = Math.round(w * 0.74)
			const frac = Math.round(Math.max(0, Math.min(1, l.rem / d.totalMs)) * bw) / bw // whole pixels: fewer redraws
			const fill = barFill
			const track = look.colourTarget === 'background' ? [0, 0, 0, 0.25] : [255, 255, 255, 0.12]
			const key = [w, h, frac, fill.map(Math.round).join(), track.join()].join('|')
			if (key !== this.barKey) {
				this.barKey = key
				this.barPng = PNG.progressBar(w, h, frac, [...fill.map(Math.round), 1], track)
			}
			out.png64 = this.barPng
		}
		return out
	}

	// ---------------- presets ----------------
	presets() {
		const v = (name) => `$(${this.label}:${name})`
		const btn = (category, name, text, actionId, options = {}, feedbacks = [], size = '14') => ({
			type: 'button',
			category,
			name,
			style: { text, size, color: WHITE, bgcolor: BLACK },
			steps: [{ down: [{ actionId, options }], up: [] }],
			feedbacks,
		})
		// Presets must spell out a boolean feedback's style: Companion 5 turns a missing one into
		// "override everything with nothing", which blanks the button whenever the feedback is on.
		const defs = this.feedbacks()
		const fb = (feedbackId, options = {}, style) => {
			const def = defs[feedbackId]
			const s = def.type === 'boolean' ? { ...def.defaultStyle, ...style } : undefined
			return { feedbackId, options, ...(s ? { style: s } : {}) }
		}
		const p = {}
		p.time = {
			...btn(
				'Transport',
				'Timer (start / pause)',
				`${v('time')}\\n${v('status')}`,
				'toggle',
				{},
				[fb('timer_colour')],
				'auto',
			),
		}
		p.toggle = btn('Transport', 'Start / pause', 'START\\nPAUSE', 'toggle', {}, [
			fb('status', { status: 'running' }, { bgcolor: GREEN, color: WHITE }),
			fb('status', { status: 'paused' }, { bgcolor: AMBER, color: BLACK }),
		])
		p.go = btn('Transport', 'Go (selected cue)', `GO\\n${v('picked_name')}`, 'go', {}, [fb('picked_any')])
		p.reset = btn('Transport', 'Reset', 'RESET', 'reset')
		p.prev = btn('Transport', 'Previous cue', '◀ PREV', 'prev')
		p.next = btn('Transport', 'Next cue', `NEXT ▶\\n${v('next_name')}`, 'next')
		p.plus1 = btn('Transport', '+1 minute', '+1:00', 'adjust', { dir: '+', min: 1, sec: 0 }, [], '18')
		p.minus1 = btn('Transport', '−1 minute', '−1:00', 'adjust', { dir: '-', min: 1, sec: 0 }, [], '18')
		p.plus5 = btn('Transport', '+5 minutes', '+5:00', 'adjust', { dir: '+', min: 5, sec: 0 }, [], '18')
		p.minus5 = btn('Transport', '−5 minutes', '−5:00', 'adjust', { dir: '-', min: 5, sec: 0 }, [], '18')
		p.flash = btn('Stage', 'Flash', 'FLASH', 'flash', { do: 'flash' }, [fb('flashing')])
		p.blackout = btn('Stage', 'Blackout', 'BLACK\\nOUT', 'blackout', { do: 'toggle' }, [fb('blackout')])
		p.clock = btn('Stage', 'Time of day', 'TIME OF\\nDAY', 'clock', { do: 'toggle' }, [fb('clock')])
		p.msg = btn(
			'Stage',
			'Message: wrap up',
			'WRAP\\nUP',
			'message',
			{ text: 'Please wrap up', mode: 'under', flash: true },
			[],
		)
		p.clear_msg = btn('Stage', 'Clear message', 'CLEAR\\nMSG', 'clear_message', {}, [fb('message')])
		for (let i = 1; i <= PRESET_CUES; i++) {
			p[`cue${i}`] = btn(
				'Cues',
				`Cue ${i}`,
				`${i}. ${v(`cue_${i}_name`)}\\n${v(`cue_${i}_length`)}`,
				'cue',
				{ n: i, mode: 'select' },
				[fb('cue_live', { n: i }), fb('cue_picked', { n: i })],
				'auto',
			)
		}
		for (const m of [1, 2, 5, 10, 15, 30]) {
			p[`quick${m}`] = btn(
				'Quick timers',
				`${m} minutes`,
				`${m}:00`,
				'quick',
				{ len: String(m), start: false },
				[],
				'18',
			)
		}
		p.show_time = btn(
			'Display only',
			'Stage preview (timer / time of day / message)',
			v('stage_main'),
			'toggle',
			{},
			[fb('stage_look')],
			'18',
		)
		p.show_time.steps = [{ down: [], up: [] }]
		p.show_schedule = {
			...btn(
				'Display only',
				'Schedule (late / ahead + show end)',
				`${v('schedule_short')}\\nEnds\\n${v('show_end')}`,
				'toggle',
				{},
				[
					fb('schedule', { state: 'late' }, { bgcolor: AMBER, color: BLACK }),
					fb('schedule', { state: 'ahead' }, { bgcolor: GREEN, color: WHITE }),
					fb('schedule', { state: 'ontime' }, { bgcolor: GREEN, color: WHITE }),
				],
				'auto',
			),
			steps: [{ down: [], up: [] }],
		}
		p.show_cue = {
			...btn('Display only', 'Live cue', `NOW\\n${v('cue_name')}`, 'toggle'),
			steps: [{ down: [], up: [] }],
		}
		p.show_next = {
			...btn('Display only', 'Next cue', `NEXT\\n${v('next_name')}`, 'toggle'),
			steps: [{ down: [], up: [] }],
		}
		p.show_tod = {
			...btn('Display only', 'Time of day', v('time_of_day'), 'toggle', {}, [], '18'),
			steps: [{ down: [], up: [] }],
		}
		return p
	}
}

runEntrypoint(StageTimerInstance, [])
