'use strict';

// Window half of 糯籽 (Nuozi): paints the sprite inside an operating-system window
// and owns the action states that only exist on a desktop.
//
// The atlas vocabulary — cell size, rows, frame counts, timings and the 握草
// staging — is read from the Client half (client.js) instead of being restated
// here, so the two surfaces cannot drift apart.
//
// Deliberate differences from the in-app surface:
//   * no `typing` state — a desktop pet has no composer to watch;
//   * `drag` and `stroll` move the window rather than a DOM box;
//   * the hidden idle easter egg stays in-app only: its frames are staged as a
//     page-sized overlay and its content is a surprise the Web GUI owns.

(() => {
	const api = window.nuoziDesktop;

	// A transparent frameless window has no console, so failures are reported
	// before anything else can throw.
	window.addEventListener('error', (event) => {
		try { api?.ready?.({ error: `${event.message} @${event.filename}:${event.lineno}` }); } catch { /* no bridge */ }
	});
	window.addEventListener('unhandledrejection', (event) => {
		try { api?.ready?.({ error: `unhandled rejection: ${event.reason}` }); } catch { /* no bridge */ }
	});
	if (!api) return;

	const registration = window.__nuoziClientModule;
	if (!registration || typeof registration.factory !== 'function') {
		api.ready({ error: 'client.js did not register through the loader shim' });
		return;
	}
	// The factory is pure until the component renders, and the desktop surface
	// never renders it, so a stub require is enough to read the vocabulary.
	const vocabulary = registration.factory(() => ({}))?.vocabulary;
	if (!vocabulary) {
		api.ready({ error: 'client.js exposes no vocabulary for the desktop carrier' });
		return;
	}

	const {
		cellW: CELL_W, cellH: CELL_H, atlasW: ATLAS_W, atlasH: ATLAS_H,
		row: ROW, loop: LOOP, look: LOOK_FRAMES,
	} = vocabulary;
	const STAGING = vocabulary.staging ?? { grassMs: 1100, failedMs: 150 };

	/** Transparent margin around the sprite; the desktop window's own geometry. */
	const PAD = 16;
	const TICK_MS = 140;
	const STEP_MS = 100;
	const ALPHA_FLOOR = 24;
	// Absolute on the pet:// origin: this page lives under desktop/, so a
	// relative path would resolve to desktop/assets/.
	const ATLAS = '/assets/atlas.png';
	const GRASS = '/assets/grass.png';
	const ONE_SHOT = new Set(['waving', 'jumping']);

	const stage = document.getElementById('stage');
	const sprite = document.getElementById('sprite');
	const grass = document.getElementById('grass');

	// ---- geometry --------------------------------------------------------------

	let geo = { scale: 0.55, petW: Math.round(CELL_W * 0.55), petH: Math.round(CELL_H * 0.55) };

	function applyGeometry(next) {
		geo = { ...geo, ...next };
		stage.style.width = `${geo.petW + PAD * 2}px`;
		stage.style.height = `${geo.petH + PAD * 2}px`;
		sprite.style.left = `${PAD}px`;
		sprite.style.top = `${PAD}px`;
		sprite.style.width = `${geo.petW}px`;
		sprite.style.height = `${geo.petH}px`;
		sprite.style.backgroundSize = `${ATLAS_W * geo.scale}px ${ATLAS_H * geo.scale}px`;
		// Scale changes every cell offset, so the next paint must rewrite it.
		sprite.dataset.painted = '';
		grass.style.width = `${Math.round(geo.petH * 1.55)}px`;
		grass.style.height = `${Math.round(geo.petH * 1.5)}px`;
		document.documentElement.style.width = stage.style.width;
		document.documentElement.style.height = stage.style.height;
		document.body.style.width = stage.style.width;
		document.body.style.height = stage.style.height;
		trace(`geometry ${JSON.stringify(geo)} ${report()}`);
	}

	// ---- state -----------------------------------------------------------------

	let display = { kind: 'anim', anim: 'idle' };
	let cell = { row: 0, col: 0 };
	let atlasLoaded = false;
	let atlasAlpha = null;
	let host = { ok: false, working: false, waiting: false, error: null, userAt: null, cfg: {} };
	let interactive = false;
	let dragging = false;
	let stroll = { moving: false, dir: 1 };
	let lastClickAt = 0;
	let lastDisplayKey = '';

	const machine = { phase: 'idle', until: 0, data: {} };
	const slots = { base: null };

	const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
	const rand = (min, max) => min + Math.random() * (max - min);

	// Opt-in, throttled trace.
	let lastTraceAt = 0;
	function trace(message) {
		const now = Date.now();
		if (now - lastTraceAt < 400) return;
		lastTraceAt = now;
		try { api.trace(message); } catch { /* tracing is best-effort */ }
	}

	function report() {
		const rect = sprite.getBoundingClientRect();
		return JSON.stringify({
			rect: [Math.round(rect.left), Math.round(rect.top), Math.round(rect.width), Math.round(rect.height)],
			bgPos: sprite.style.backgroundPosition,
			alpha: atlasAlpha ? 'ready' : 'null',
			cell: `${cell.row}/${cell.col}`,
			display: display.kind === 'frame' ? `frame ${display.row}/${display.col}` : display.kind,
		});
	}

	// ---- sprite painter (rAF, direct style writes) ------------------------------

	let animName = null;
	let animStart = performance.now();

	/**
	 * Writes the sprite cell only when it changes: a pet that idles for hours must
	 * not rewrite an identical style 60 times a second.
	 * @param {number} row
	 * @param {number} col
	 */
	function setCell(row, col) {
		if (sprite.dataset.painted === 'yes' && cell.row === row && cell.col === col) return;
		cell = { row, col };
		sprite.dataset.painted = 'yes';
		sprite.style.backgroundPosition = `${-col * CELL_W * geo.scale}px ${-row * CELL_H * geo.scale}px`;
	}

	function paint(now) {
		requestAnimationFrame(paint);
		if (display.kind === 'image') {
			// easter-egg style overlay frame (握草 keypose)
			if (grass.dataset.show !== display.src) {
				grass.dataset.show = display.src;
				grass.src = display.src;
			}
			if (grass.hidden) grass.hidden = false;
			if (sprite.style.visibility !== 'hidden') sprite.style.visibility = 'hidden';
			return;
		}
		if (!grass.hidden) grass.hidden = true;
		if (sprite.style.visibility === 'hidden') sprite.style.visibility = '';

		if (display.kind === 'frame') {
			// static atlas cell (look-around, failed-collapse hold)
			setCell(display.row, display.col);
			return;
		}
		const loop = LOOP[display.anim] ?? LOOP.idle;
		if (animName !== display.anim) {
			animName = display.anim;
			animStart = now;
		}
		const elapsed = Math.max(0, now - animStart);
		const frame = ONE_SHOT.has(display.anim)
			? Math.min(Math.floor(elapsed / loop.ms), loop.frames - 1)
			: Math.floor(elapsed / loop.ms) % loop.frames;
		setCell(loop.row, frame);
	}

	// ---- atlas alpha hit test ---------------------------------------------------

	const atlasImage = new Image();
	atlasImage.addEventListener('load', () => {
		atlasLoaded = true;
		const canvas = document.createElement('canvas');
		canvas.width = ATLAS_W;
		canvas.height = ATLAS_H;
		const context = canvas.getContext('2d', { willReadFrequently: true });
		context.drawImage(atlasImage, 0, 0);
		atlasAlpha = context.getImageData(0, 0, ATLAS_W, ATLAS_H).data;
		api.ready({ atlas: `${atlasImage.naturalWidth}x${atlasImage.naturalHeight}`, geo });
	});
	atlasImage.addEventListener('error', () => api.ready({ atlas: 'failed', src: ATLAS }));
	atlasImage.src = ATLAS;
	sprite.style.backgroundImage = `url("${ATLAS}")`;

	/**
	 * True only where the character actually has pixels: the transparent margin
	 * inside the sprite cell must stay click-through, or the window would swallow
	 * clicks on a rectangle it does not visually occupy.
	 * @param {number} x
	 * @param {number} y
	 * @returns {boolean}
	 */
	function hitTest(x, y) {
		// No atlas, nothing on screen: the window must not swallow anything.
		if (!atlasLoaded) return false;
		const rect = sprite.getBoundingClientRect();
		const localX = x - rect.left;
		const localY = y - rect.top;
		if (localX < 0 || localY < 0 || localX >= rect.width || localY >= rect.height) return false;
		// Pixels unavailable but the sprite is drawn: keep the pet usable.
		if (!atlasAlpha) return true;
		const atlasX = Math.floor(cell.col * CELL_W + localX / geo.scale);
		const atlasY = Math.floor(cell.row * CELL_H + localY / geo.scale);
		if (atlasX < 0 || atlasY < 0 || atlasX >= ATLAS_W || atlasY >= ATLAS_H) return false;
		return atlasAlpha[(atlasY * ATLAS_W + atlasX) * 4 + 3] > ALPHA_FLOOR;
	}

	function setInteractive(on) {
		if (on === interactive) return;
		interactive = on;
		api.interactive(on);
	}

	// ---- input ------------------------------------------------------------------

	// Authoritative hover signal: the main process owns the cursor position, so
	// click-through works even though the OS routes events past an ignoring window.
	api.onCursor((point) => {
		if (dragging || !point) return;
		const hit = hitTest(point.x, point.y);
		trace(`cursor ${point.x},${point.y} hit=${hit} ${report()}`);
		setInteractive(hit);
	});

	// Wheel over the pet resizes it. Wheel events only arrive while the window is
	// interactive, which is exactly when the cursor is on the character.
	window.addEventListener('wheel', (event) => {
		if (!hitTest(event.clientX, event.clientY)) return;
		event.preventDefault();
		api.setScale(geo.scale + (event.deltaY > 0 ? -0.05 : 0.05));
	}, { passive: false });

	document.addEventListener('contextmenu', (event) => {
		if (!hitTest(event.clientX, event.clientY)) return;
		event.preventDefault();
		api.menu();
	});

	let down = null;
	/** Keeps the drag alive while the button is held but the pointer is still. */
	let keepAlive = null;

	/**
	 * Ends the drag from the renderer side. Called on pointerup, on pointercancel,
	 * and as soon as any pointer event reveals the button is no longer down.
	 * @returns {boolean} whether a drag was in progress
	 */
	function finishDrag() {
		if (!dragging) return false;
		api.dragEnd();
		dragging = false;
		if (keepAlive) {
			clearInterval(keepAlive);
			keepAlive = null;
		}
		delete stage.dataset.dragging;
		machine.phase = 'idle';
		machine.until = 0;
		machine.data = { reschedule: true };
		return true;
	}

	function onPointerMove(event) {
		if (!down) return;
		down.buttons = event.buttons;
		if (!dragging) {
			const movedBy = Math.abs(event.clientX - down.x) + Math.abs(event.clientY - down.y);
			if (movedBy <= 6) return;
			dragging = true;
			stage.dataset.dragging = 'true';
			machine.phase = 'drag';
			machine.until = Infinity;
			machine.data = { dir: 1 };
			api.dragBegin();
			// A held but motionless pointer produces no pointermove, and the main
			// process would read that silence as a dropped pointerup and end the
			// drag under the user's hand.
			keepAlive = setInterval(() => {
				if (down && (down.buttons & 1) === 0) {
					finishDrag();
					return;
				}
				api.dragMove();
			}, 200);
			return;
		}
		if ((event.buttons & 1) === 0) {
			finishDrag();
			return;
		}
		api.dragMove();
	}

	function onPointerUp(event) {
		document.removeEventListener('pointermove', onPointerMove);
		document.removeEventListener('pointerup', onPointerUp);
		document.removeEventListener('pointercancel', onPointerUp);
		try {
			sprite.releasePointerCapture(event.pointerId);
		} catch {
			/* capture may already be gone */
		}

		const wasDragging = finishDrag();

		const started = down;
		down = null;
		if (wasDragging || !started) return;

		const quick = Date.now() - started.at < 400;
		const still = Math.abs(event.clientX - started.x) + Math.abs(event.clientY - started.y) <= 6;
		if (!quick || !still) return;

		const now = Date.now();
		if (now - lastClickAt < 320) {
			// double click: jump
			lastClickAt = 0;
			machine.phase = 'jumping';
			machine.until = now + 1300;
			machine.data = { base: baseFromHost() };
			return;
		}
		// single click: pat the pet
		lastClickAt = now;
		machine.phase = 'waving';
		machine.until = now + 1300;
		machine.data = { base: baseFromHost() };
	}

	document.addEventListener('pointerdown', (event) => {
		if (event.button !== 0) return;
		if (!hitTest(event.clientX, event.clientY)) return;
		down = { x: event.clientX, y: event.clientY, at: Date.now(), buttons: event.buttons };
		// Tell the main process where the drag starts while the pointer is still
		// exactly on the press point; the renderer's threshold only decides *when*
		// the drag becomes a drag, never how far it has already travelled.
		api.dragPrepare();
		setInteractive(true);
		try {
			sprite.setPointerCapture(event.pointerId);
		} catch {
			/* capture is best-effort */
		}
		document.addEventListener('pointermove', onPointerMove);
		document.addEventListener('pointerup', onPointerUp);
		document.addEventListener('pointercancel', onPointerUp);
	});

	// ---- action state machine ---------------------------------------------------

	function baseFromHost() {
		if (host.waiting) return 'waiting';
		if (host.working) return 'working';
		return 'idle';
	}

	/** 握草 / offline: a transient reaction that outranks every work state. */
	function errorPhase(now) {
		const error = host?.error;
		if (!error || !Number.isFinite(error.at)) return null;
		const hold = Number(host?.cfg?.errorHoldMs) || 3200;
		if (now - error.at > hold + 600) return null;
		return { phase: 'error', until: error.at + hold + 500, data: { errAt: error.at, failAt: error.at + STAGING.grassMs } };
	}

	function tick() {
		const now = Date.now();
		const m = machine;
		if (m.phase === 'drag') return;

		const failure = errorPhase(now);
		if (failure) {
			if (m.phase !== 'error') {
				machine.phase = failure.phase;
				machine.until = failure.until;
				machine.data = failure.data;
			} else {
				machine.until = failure.until;
			}
			return;
		}
		if (m.phase === 'error') {
			machine.phase = 'idle';
			machine.until = 0;
			machine.data = { reschedule: true };
		}

		if (m.phase !== 'idle' && m.phase !== 'working' && m.phase !== 'waiting' && now < m.until) return;

		const base = baseFromHost();

		// A user message just landed: greet with a wave when not mid-task.
		if (host.userAt && now - host.userAt < 1600 && base !== 'working' && (m.data.waveAt ?? 0) < host.userAt) {
			machine.phase = 'waving';
			machine.until = now + 1800;
			machine.data = { base, waveAt: host.userAt };
			return;
		}

		// Window-level pacing is owned by the main process; mirror it as a phase.
		if (stroll.moving) {
			machine.phase = 'stroll';
			machine.until = now + 500;
			machine.data = { base };
			return;
		}

		if (base === 'idle') {
			slots.base = null;
			if (m.phase !== 'idle') {
				machine.phase = 'idle';
				machine.until = 0;
				machine.data = { nextWave: now + rand(9000, 22000) };
				return;
			}
			if (m.data.nextWave !== undefined && now >= m.data.nextWave) {
				machine.phase = 'waving';
				machine.until = now + rand(1400, 2200);
				machine.data = { base: 'idle' };
			}
			return;
		}

		// working and waiting share the look-and-pace vocabulary.
		if (slots.base !== base) {
			slots.base = base;
			slots.nextLook = now + rand(4000, base === 'working' ? 11000 : 10000);
			slots.nextBusy = now + rand(4500, 9000);
			slots.nextStroll = now + rand(6000, 14000);
		}
		if (m.phase !== base) {
			machine.phase = base;
			machine.until = 0;
			machine.data = { base };
			return;
		}
		if (slots.nextLook !== undefined && now >= slots.nextLook) {
			slots.nextLook = now + rand(4000, base === 'working' ? 11000 : 10000);
			machine.phase = 'look';
			machine.until = now + rand(1300, 2600);
			machine.data = { base, index: Math.floor(Math.random() * 16) };
			return;
		}
		if (base === 'working' && slots.nextBusy !== undefined && now >= slots.nextBusy) {
			slots.nextBusy = now + rand(4500, 9000);
			machine.phase = 'busy';
			machine.until = now + rand(2800, 4300);
			machine.data = { base };
			return;
		}
		if (slots.nextStroll !== undefined && now >= slots.nextStroll) {
			slots.nextStroll = now + rand(12000, 26000);
			// Reduced motion is a standing request, not a one-off: no pacing.
			if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
				api.stroll({
					range: Math.round(rand(60, 180) * (Math.random() < 0.5 ? -1 : 1)),
					speed: Math.round(rand(45, 65)),
				});
			}
		}
	}

	// ---- display derivation -----------------------------------------------------

	function step() {
		const m = machine;
		let mode = 'idle';
		switch (m.phase) {
			case 'working':
				display = { kind: 'anim', anim: 'review' };
				mode = 'working';
				break;
			case 'waiting':
				display = { kind: 'anim', anim: 'waiting' };
				mode = 'waiting';
				break;
			case 'busy':
				display = { kind: 'anim', anim: 'running' };
				mode = 'working';
				break;
			case 'waving':
				display = { kind: 'anim', anim: 'waving' };
				mode = 'waving';
				break;
			case 'jumping':
				display = { kind: 'anim', anim: 'jumping' };
				mode = 'jumping';
				break;
			case 'look': {
				const frame = LOOK_FRAMES[m.data.index ?? 0];
				display = { kind: 'frame', row: frame.row, col: frame.col };
				mode = 'look';
				break;
			}
			case 'drag':
				display = { kind: 'anim', anim: (m.data.dir ?? 1) > 0 ? 'runningRight' : 'runningLeft' };
				mode = 'drag';
				break;
			case 'stroll':
				if (stroll.moving) {
					display = { kind: 'anim', anim: stroll.dir > 0 ? 'runningRight' : 'runningLeft' };
				} else {
					display = { kind: 'anim', anim: m.data.base === 'waiting' ? 'waiting' : 'review' };
				}
				mode = m.data.base ?? 'idle';
				break;
			case 'error': {
				const errAt = m.data.errAt ?? Date.now();
				const failAt = m.data.failAt ?? errAt + STAGING.grassMs;
				if (Date.now() - errAt < STAGING.grassMs) {
					display = { kind: 'image', src: GRASS };
				} else {
					const frame = clamp(Math.floor((Date.now() - failAt) / STAGING.failedMs), 0, LOOP.failed.frames - 1);
					display = { kind: 'frame', row: ROW.failed, col: frame };
				}
				mode = 'error';
				break;
			}
			default:
				display = { kind: 'anim', anim: 'idle' };
		}
		if (stage.dataset.mode !== mode) stage.dataset.mode = mode;
		// Trace transitions only — a few lines a minute, and the only way to
		// observe the state link from outside a transparent window. Never folded
		// into the throttled trace: the first transition is the interesting one.
		const key = display.kind === 'frame'
			? `frame ${display.row}/${display.col}`
			: display.kind === 'image' ? `image ${display.src}` : `anim ${display.anim}`;
		if (key !== lastDisplayKey) {
			lastDisplayKey = key;
			lastTraceAt = Date.now();
			try { api.trace(`display ${key} phase=${machine.phase} base=${baseFromHost()}`); } catch { /* tracing is best-effort */ }
		}
	}

	// ---- bridge -----------------------------------------------------------------

	api.onHostState((next) => {
		host = next ?? host;
	});
	api.onGeometry((next) => applyGeometry(next));
	api.onStroll((next) => {
		stroll = next ?? stroll;
	});
	api.onDragDirection((direction) => {
		if (machine.phase === 'drag') machine.data.dir = direction;
	});

	// The main process sizes the window from this, so the cell size has exactly
	// one definition: the Client half's vocabulary.
	api.metrics({ cellW: CELL_W, cellH: CELL_H, pad: PAD });
	api.ready({ vocabulary: { cell: `${CELL_W}x${CELL_H}`, atlas: `${ATLAS_W}x${ATLAS_H}`, loops: Object.keys(LOOP).length } });

	requestAnimationFrame(paint);
	setInterval(tick, TICK_MS);
	setInterval(step, STEP_MS);
})();
