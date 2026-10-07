// Client half of the 糯籽 (Nuozi) desktop pet for DeepSeek Harness.
//
// Renders the pet in the frame-wide shell.overlay slot and links its action
// states to DSH working state (polled from the Host half's /nuozi-pet/state):
//
//   idle      no work (无任务) — standing breathing/blink loop with an
//             occasional spontaneous hoof-raise wave
//   working   any agent running (Running) — hard at thinking: review-style
//             think/inspect loop + 16-way looks + short pacing strolls that
//             return to the anchor, plus a regular row-7 busy-work drama
//             (处理中→思考→疲惫→惊醒→恢复工作, ~3s each)
//   waiting   approval / user question pending (Needs input) — the row-6
//             loop (asset content: standing and waiting, lifting a hoof,
//             observing), plus small impatient pacing strolls
//   typing    caret focused in the composer — reuses the look-around loop
//             while focused, only while the pet is otherwise free
//   (Ready)   a finished turn returns straight to idle — the think/inspect
//             row belongs to working now, so free time never fakes thinking
//   waving    user sent a message / pet was patted
//   jumping   pet was double-clicked
//   drag      held by the user — run loop matching the drag direction
//   error     offline / command error (Blocked-ish) — 握草 instant keypose,
//             then the failed collapse played once, held on its last frame
//   dad       hidden idle easter egg — small chance per idle check
//
// Offline is additionally detected in-page (window offline events, failed
// polls) so 断网 shows instantly even between polls.

window.__ModuleLoader__.load({
	id: '@local/nuozi-pet',
	factory(require) {
		const React = require('react');
		const h = React.createElement;

		// ---- atlas geometry (nuozi pet_request.json, sprite v2) -------------
		const CELL_W = 192;
		const CELL_H = 208;
		const ATLAS_W = 1536;
		const ATLAS_H = 2288;
		const ROW = {
			idle: 0, runningRight: 1, runningLeft: 2, waving: 3, jumping: 4,
			failed: 5, waiting: 6, running: 7, review: 8,
		};
		const LOOP = {
			idle: { row: ROW.idle, frames: 6, ms: 170 },
			// row-7 busy-work drama per the delivery table: 工作处理中 → 思考 →
			// 疲惫 → 惊醒 → 恢复工作; 230ms so the tired/startle beats read.
			// Not a running loop.
			running: { row: ROW.running, frames: 6, ms: 230 },
			runningRight: { row: ROW.runningRight, frames: 8, ms: 110 },
			runningLeft: { row: ROW.runningLeft, frames: 8, ms: 110 },
			waving: { row: ROW.waving, frames: 4, ms: 200 },
			jumping: { row: ROW.jumping, frames: 5, ms: 130 },
			failed: { row: ROW.failed, frames: 8, ms: 150 },
			// 交付包权威语义：站立等待、抬蹄、眨眼、左右观察（行号经 rows-final
			// 审批帧逐帧比对 IoU 1.00）。早期设计文档的“坐着晃脚”未进入最终图集，
			// 勿再按坐姿/晃脚预期调整本行的播放参数或文案。
			waiting: { row: ROW.waiting, frames: 6, ms: 280 },
			review: { row: ROW.review, frames: 6, ms: 200 },
		};
		// easter-egg staging (bubbles are baked into frames 3-4, so give each
		// a readable beat; ends with an eyes-open/closed blink loop on 2↔5)
		const DAD_SEQ_MS = 2740; // 200 stand + 170 sink + 170 lie + 1100 + 1100
		const DAD_HOLD_MS = 2600; // blink beats before a normal run ends
		// grass keypose hold before the failed collapse starts
		const GRASS_MS = 1100;
		const FAILED_MS = 150;
		// 16 look directions, clockwise from up (assembly-manifest.json).
		const LOOK_FRAMES = [];
		for (let i = 0; i < 16; i++) LOOK_FRAMES.push({ row: i < 8 ? 9 : 10, col: i % 8 });

		const STATE_URL = '/nuozi-pet/state';
		const ASSET = (name) => `/nuozi-pet/assets/${name}`;
		const POS_KEY = 'nuozi-pet:pos';

		const rand = (min, max) => min + Math.random() * (max - min);
		const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

		const CSS = [
			'.nuozi-pet-root { position: fixed; left: 0; top: 0; z-index: 60; pointer-events: none; }',
			'.nuozi-pet-stage { position: relative; pointer-events: auto; touch-action: none;',
			'  user-select: none; -webkit-user-select: none; cursor: grab;',
			'  filter: drop-shadow(0 6px 10px rgba(0,0,0,.18)); }',
			'.nuozi-pet-stage[data-dragging="true"] { cursor: grabbing; }',
			'.nuozi-pet-sprite { position: absolute; bottom: 0; left: 50%;',
			'  transform: translateX(-50%); background-repeat: no-repeat;',
			'  background-size: 100% 100%; }',
			'.nuozi-pet-img { position: absolute; left: 50%; bottom: 0; transform: translateX(-50%); }',
			'.nuozi-pet-bubble { position: absolute; left: 55%; bottom: 92%; transform-origin: 15% 85%;',
			'  background: #fff; color: #333; border: 2px solid #2c3e66; border-radius: 12px;',
			'  padding: 3px 10px; font-size: 13px; font-weight: 600; white-space: nowrap;',
			'  box-shadow: 0 2px 8px rgba(0,0,0,.15); pointer-events: none;',
			'  animation: nuozi-pet-pop .28s cubic-bezier(.2,1.6,.4,1) both; }',
			'.nuozi-pet-bubble::after { content: ""; position: absolute; left: 14px; bottom: -7px;',
			'  width: 10px; height: 10px; background: #fff; border-right: 2px solid #2c3e66;',
			'  border-bottom: 2px solid #2c3e66; transform: rotate(45deg); }',
			'@keyframes nuozi-pet-pop { from { transform: scale(.3); opacity: 0; }',
			'  to { transform: scale(1); opacity: 1; } }',
			'.nuozi-pet-stage[data-mode="error"] { animation: nuozi-pet-shake .5s ease-in-out 2; }',
			// (dad mode shows no DOM bubble — its bubbles are baked into the frames)
			'@keyframes nuozi-pet-shake { 0%,100% { translate: 0 0; } 25% { translate: -4px 0; }',
			'  55% { translate: 4px 0; } 80% { translate: -2px 0; } }',
			'@media (prefers-reduced-motion: reduce) {',
			'  .nuozi-pet-stage[data-mode="error"] { animation: none; } }',
		].join('\n');

		// ---- one polling source of truth -------------------------------------
		function useHostState(pollMs) {
			const hostRef = React.useRef(null);
			const localErrRef = React.useRef(null);
			React.useEffect(() => {
				let timer = null;
				const offline = () => { localErrRef.current = { kind: 'offline', at: Date.now() }; };
				const online = () => { localErrRef.current = null; };
				const poll = async () => {
					try {
						const response = await fetch(STATE_URL, { cache: 'no-store' });
						if (!response.ok) throw new Error(String(response.status));
						hostRef.current = await response.json();
					} catch {
						if (location.protocol === 'http:' || location.protocol === 'https:') {
							localErrRef.current = { kind: 'connection', at: Date.now() };
						}
					}
				};
				poll();
				timer = window.setInterval(() => {
					if (!document.hidden) poll();
				}, pollMs);
				window.addEventListener('offline', offline);
				window.addEventListener('online', online);
				return () => {
					window.clearInterval(timer);
					window.removeEventListener('offline', offline);
					window.removeEventListener('online', online);
				};
			}, [pollMs]);
			return { hostRef, localErrRef };
		}

		// ---- composer focus (page-local signal) -------------------------------
		// Caret parked in a text field = "user is composing": true while the
		// focused element is editable, false the moment focus leaves it
		// (including when the whole window loses focus).
		function useTypingTracker() {
			const typingRef = React.useRef(false);
			React.useEffect(() => {
				const isEditable = (el) => !!(el && el.tagName && (
					el.tagName === 'TEXTAREA'
					|| (el.tagName === 'INPUT' && /^(?:text|search|url|tel|email|password|number)$/.test(el.type || 'text'))
					|| el.isContentEditable
				));
				const sync = () => { typingRef.current = isEditable(document.activeElement); };
				// during focusout the activeElement may not have settled yet
				const syncSoon = () => window.setTimeout(sync, 0);
				const onBlur = () => { typingRef.current = false; };
				window.addEventListener('focusin', sync, true);
				window.addEventListener('focusout', syncSoon, true);
				window.addEventListener('blur', onBlur);
				document.addEventListener('visibilitychange', sync);
				sync();
				return () => {
					window.removeEventListener('focusin', sync, true);
					window.removeEventListener('focusout', syncSoon, true);
					window.removeEventListener('blur', onBlur);
					document.removeEventListener('visibilitychange', sync);
				};
			}, []);
			return typingRef;
		}

		// ---- sprite painter (direct DOM writes, no per-frame React churn) ----
		function useSpritePainter(spriteRef, displayRef, scale) {
			React.useEffect(() => {
				let raf = 0;
				let animName = null;
				let animStart = performance.now();
				const paint = (now) => {
					raf = requestAnimationFrame(paint);
					const el = spriteRef.current;
					if (!el) return;
					const d = displayRef.current;
					if (d.kind === 'image') {
						if (el.dataset.show !== d.src) {
							el.dataset.show = d.src;
							el.style.backgroundImage = `url("${d.src}")`;
							el.style.width = `${d.w}px`;
							el.style.height = `${d.h}px`;
							// must reset: the atlas branch leaves a scaled inline
							// background-size that stretches easter-egg frames
							// and crops them into empty corners (vanishing pet).
							el.style.backgroundSize = '100% 100%';
							el.style.backgroundPosition = '0 0';
						}
						return;
					}
					if (el.dataset.show !== 'atlas') {
						el.dataset.show = 'atlas';
						el.style.backgroundImage = `url("${ASSET('atlas.png')}")`;
						el.style.width = `${CELL_W * scale}px`;
						el.style.height = `${CELL_H * scale}px`;
						el.style.backgroundSize = `${ATLAS_W * scale}px ${ATLAS_H * scale}px`;
					}
					if (d.kind === 'frame') {
						// static atlas cell (look-around, failed-collapse hold)
						el.style.backgroundPosition = `${-d.col * CELL_W * scale}px ${-d.row * CELL_H * scale}px`;
						return;
					}
					const loop = LOOP[d.anim];
					// Restart an animation when its state changes. One-shot reactions
					// must play from their first frame and hold their landing frame;
					// looping states continue cycling normally.
					if (animName !== d.anim) {
						animName = d.anim;
						animStart = now;
					}
					const elapsed = Math.max(0, now - animStart);
					const oneShot = d.anim === 'waving' || d.anim === 'jumping';
					const frame = oneShot
						? Math.min(Math.floor(elapsed / loop.ms), loop.frames - 1)
						: Math.floor(elapsed / loop.ms) % loop.frames;
					el.style.backgroundPosition = `${-frame * CELL_W * scale}px ${-loop.row * CELL_H * scale}px`;
				};
				raf = requestAnimationFrame(paint);
				return () => cancelAnimationFrame(raf);
			}, [spriteRef, displayRef, scale]);
		}

		function NuoziPet() {
			// Config arrives with the host snapshot; defaults until first poll.
			const [cfg, setCfg] = React.useState({ scale: 0.55, dadChance: 0.15, dadCheckIntervalMs: 30000, errorHoldMs: 3200 });
			const scale = cfg.scale;
			const petW = Math.round(CELL_W * scale);
			const petH = Math.round(CELL_H * scale);

			const { hostRef, localErrRef } = useHostState(1000);
			const typingRef = useTypingTracker();
			const spriteRef = React.useRef(null);
			const stageRef = React.useRef(null);
			const displayRef = React.useRef({ kind: 'anim', anim: 'idle' });

			// machine = { phase, until, data } — phase one of
			// idle|working|waiting|typing|waving|jumping|error|dad|look|walk|drag|busy
			const machineRef = React.useRef({ phase: 'idle', until: 0, data: {} });
			// easter-egg check timer, kept out of phase data so it survives
			// phase transitions (idle ⇄ waiting)
			const eggCheckRef = React.useRef(0);
			const [paint, setPaint] = React.useState({ mode: 'idle', bubble: null });
			const posRef = React.useRef(null);
			// base-state slot timers — persist across brief interruptions so a
			// frequent slot (busy drama) can never starve a slower one (pace)
			const slotsRef = React.useRef({ base: null });

			useSpritePainter(spriteRef, displayRef, scale);

			// position: restore from localStorage or anchor bottom-right
			// (layout effect: placed before first paint, no corner flash)
			React.useLayoutEffect(() => {
				const place = () => {
					let pos = null;
					try { pos = JSON.parse(window.localStorage.getItem(POS_KEY) || 'null'); } catch { pos = null; }
					if (!pos || typeof pos.x !== 'number' || typeof pos.y !== 'number') {
						pos = { x: window.innerWidth - petW - 26, y: window.innerHeight - petH - 14 };
					}
					pos.x = clamp(pos.x, 4, Math.max(4, window.innerWidth - petW - 4));
					pos.y = clamp(pos.y, 4, Math.max(4, window.innerHeight - petH - 4));
					posRef.current = pos;
					if (stageRef.current) {
						stageRef.current.style.transform = `translate(${pos.x}px, ${pos.y}px)`;
					}
				};
				place();
				window.addEventListener('resize', place);
				return () => window.removeEventListener('resize', place);
			}, [petW, petH]);

			const applyPosition = () => {
				const el = stageRef.current;
				const pos = posRef.current;
				if (el && pos) el.style.transform = `translate(${pos.x}px, ${pos.y}px)`;
			};

			// ---- the action-state machine tick --------------------------------
			React.useEffect(() => {
				const tick = () => {
					const now = Date.now();
					const host = hostRef.current;
					if (host && host.cfg && host.cfg.dadChance !== undefined && host.cfg.dadChance !== cfg.dadChance) {
						setCfg(host.cfg);
					}
					const errorHold = (host?.cfg?.errorHoldMs ?? cfg.errorHoldMs);
					const m = machineRef.current;

					// merge host + local errors (fresher wins)
					let error = null;
					if (host?.error && now - host.error.at <= errorHold + 600) error = host.error;
					const local = localErrRef.current;
					if (local && now - local.at <= errorHold + 600 && (!error || local.at > error.at)) {
						error = { kind: local.kind, at: local.at, detail: local.kind };
					}

					const working = !!host?.working;

					// 1) 握草：断网 / 命令 error —— highest priority, throttled
					if (error && (m.phase !== 'error' || error.at > (m.data.errAt ?? 0) + 1500)) {
						machineRef.current = {
							phase: 'error', until: error.at + errorHold + 500,
							data: { errAt: error.at, failAt: error.at + GRASS_MS },
						};
						return;
					}
					if (m.phase === 'error') {
						if (now < m.until) return;
						machineRef.current = { phase: 'idle', until: 0, data: { reschedule: true } };
					}

					// held by the user: keep the carried-run display; host
					// state is re-evaluated the moment the pet is dropped
					if (m.phase === 'drag') return;

					// 2) base work state from the host. A finished turn goes
					// straight back to plain idle — no fake thinking.
					let base = 'idle';
					if (host?.waiting) base = 'waiting';
					else if (working) base = 'working';
					// caret parked in the composer = you are the pending input:
					// show the waiting pose, but never mask real work or a
					// real question
					else if (typingRef.current) base = 'typing';

					// 3) hidden idle easter egg: small chance per check, only
					//    while the pet is free (idle or waiting)
					if (m.phase === 'dad') {
						if (now < m.until) return;
						machineRef.current = { phase: 'idle', until: 0, data: { reschedule: true } };
					} else if ((base === 'idle' || base === 'waiting') && (m.phase === 'idle' || m.phase === 'waiting')) {
						if (eggCheckRef.current === 0) {
							eggCheckRef.current = now + rand(12000, 20000);
						} else if (now >= eggCheckRef.current && !document.hidden) {
							const interval = host?.cfg?.dadCheckIntervalMs ?? cfg.dadCheckIntervalMs;
							const chance = host?.cfg?.dadChance ?? cfg.dadChance;
							eggCheckRef.current = now + interval * rand(0.75, 1.35);
							if (Math.random() < chance) {
								machineRef.current = { phase: 'dad', until: now + DAD_SEQ_MS + DAD_HOLD_MS, data: { started: now } };
								return;
							}
						}
					}

					// one-shot reactions
					if (m.phase === 'waving' || m.phase === 'jumping' || m.phase === 'look' || m.phase === 'walk' || m.phase === 'busy') {
						if (now < m.until) return;
					}

					// user just sent a message: greet with a wave (when not working)
					if (host?.userAt && now - host.userAt < 1600 && base !== 'working' && (m.data.waveAt ?? 0) < host.userAt) {
						machineRef.current = { phase: 'waving', until: now + 1800, data: { base, waveAt: host.userAt } };
						return;
					}

					if (base === 'idle') slotsRef.current.base = null; // fresh slots next work state
					if (base !== 'idle') {
						// seed per base-state change only; timers survive
						// interruptions (look/busy/wave) and keep counting
						const slots = slotsRef.current;
						if (slots.base !== base) {
							slots.base = base;
							if (base === 'working') {
								slots.nextPace = now + rand(5000, 12000);
								slots.nextLook = now + rand(4000, 11000);
								slots.nextBusy = now + rand(4500, 9000);
							} else {
								slots.nextPace = now + rand(4000, 10000);
								slots.nextLook = now + rand(4000, 10000);
							}
						}
						if (m.phase !== base) {
							machineRef.current = { phase: base, until: 0, data: { base } };
							return;
						}
						const d = m.data;
						// pacing slot: working takes a stretch break, waiting
						// paces impatiently — out, pause, back to anchor;
						// nextPace is rescheduled when the return leg lands
						if (!d.pace && slots.nextPace !== undefined && now >= slots.nextPace
							&& !document.hidden && posRef.current
							&& !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
							const range = rand(60, 180) * (Math.random() < 0.5 ? -1 : 1);
							d.pace = { anchorX: posRef.current.x, targetX: posRef.current.x + range, speed: rand(45, 65), pauseUntil: 0, returning: false, moving: false };
						}
						// look slot: working thinks out loud, waiting scans
						// the room for you
						if (!d.pace && slots.nextLook !== undefined && now >= slots.nextLook && !document.hidden) {
							slots.nextLook = now + rand(4000, base === 'working' ? 11000 : 10000);
							machineRef.current = { phase: 'look', until: now + rand(1300, 2600), data: { base, index: Math.floor(Math.random() * 16) } };
							return;
						}
						// busy-drama slot (row 7): works, tires out, startles
						// awake, gets back to it — 2~3 full loops so every beat
						// of the arc reads, then straight back to thinking
						if (base === 'working' && !d.pace && slots.nextBusy !== undefined
							&& now >= slots.nextBusy && !document.hidden) {
							slots.nextBusy = now + rand(4500, 9000);
							machineRef.current = { phase: 'busy', until: now + rand(2800, 4300), data: { base } };
							return;
						}
						return;
					}

					// idle sub-behaviour: the row-0 breathing loop is the base
					// (standing, breathing swells, blinks); the only occasional
					// extra is a spontaneous hoof-raise wave (row 3: raise →
					// happy interaction → settle back)
					if (m.phase !== 'idle' || m.data.reschedule) {
						machineRef.current = {
							phase: 'idle', until: 0,
							data: { base: 'idle', nextWave: now + rand(9000, 22000) },
						};
					} else {
						const d = m.data;
						if (d.nextWave !== undefined && now >= d.nextWave) {
							machineRef.current = { phase: 'waving', until: now + rand(1400, 2200), data: { base: 'idle' } };
							return;
						}
					}
				};

				const timer = window.setInterval(tick, 140);
				return () => window.clearInterval(timer);
			}, [cfg]);

			// ---- walk movement + display + bubble derivation -------------------
			React.useEffect(() => {
				const step = () => {
					const m = machineRef.current;
					if (m.phase === 'walk' && posRef.current) {
						const dt = 0.1;
						const dist = (m.speed ?? 55) * dt * (m.direction ?? 1);
						const pos = posRef.current;
						pos.x = clamp(pos.x + dist, 4, Math.max(4, window.innerWidth - petW - 4));
						applyPosition();
					}
					if ((m.phase === 'working' || m.phase === 'waiting') && m.data.pace && posRef.current) {
						// pacing outing: out → busy/seat-pause → back to the anchor
						const pace = m.data.pace;
						const nowMs = Date.now();
						if (pace.pauseUntil) {
							if (nowMs >= pace.pauseUntil) {
								pace.targetX = pace.anchorX;
								pace.returning = true;
								pace.pauseUntil = 0;
							}
						} else {
							const tx = clamp(pace.targetX, 4, Math.max(4, window.innerWidth - petW - 4));
							const pos = posRef.current;
							const dx = tx - pos.x;
							const stepPx = pace.speed * 0.1;
							if (Math.abs(dx) <= stepPx) {
								pos.x = tx;
								pace.moving = false;
								if (pace.returning) {
									m.data.pace = null;
									slotsRef.current.nextPace = nowMs + rand(10000, 24000);
								} else {
									pace.pauseUntil = nowMs + rand(1500, 3000);
								}
							} else {
								pos.x = clamp(pos.x + Math.sign(dx) * stepPx, 4, Math.max(4, window.innerWidth - petW - 4));
								pace.dir = dx > 0 ? 1 : -1;
								pace.moving = true;
							}
							applyPosition();
						}
					}
					let display = { kind: 'anim', anim: 'idle' };
					let bubble = null;
					let mode = 'idle';
					switch (machineRef.current.phase) {
						case 'working':
						case 'waiting':
						case 'typing':
						{
							// Running reads as "thinking hard" on the review
							// think row; the row-7 busy drama is its own slot
							const baseAnim = m.phase === 'working' ? 'review' : 'waiting';
							display = m.data.pace && m.data.pace.moving
								? { kind: 'anim', anim: (m.data.pace.dir ?? 1) > 0 ? 'runningRight' : 'runningLeft' }
								: { kind: 'anim', anim: baseAnim };
							mode = m.phase;
							break;
						}
						case 'busy': display = { kind: 'anim', anim: 'running' }; mode = 'working'; break;
						case 'waving': display = { kind: 'anim', anim: 'waving' }; mode = 'waving'; break;
						case 'jumping': display = { kind: 'anim', anim: 'jumping' }; mode = 'jumping'; break;
						case 'look':
						{
							const f = LOOK_FRAMES[machineRef.current.data.index ?? 0];
							display = { kind: 'frame', row: f.row, col: f.col };
							mode = 'look';
							break;
						}
						case 'walk':
						case 'drag':
							display = { kind: 'anim', anim: ((m.phase === 'drag' ? m.data.direction : m.direction) ?? 1) > 0 ? 'runningRight' : 'runningLeft' };
							mode = 'walk';
							break;
						case 'dad':
						{
							// staging follows the source design: stand → sink →
							// lie → two baked-in bubble lines (readable beats)
							// → blink ending; no DOM bubble overlay
							const started = machineRef.current.data.started
								?? (machineRef.current.until - (DAD_SEQ_MS + DAD_HOLD_MS));
							const t = Date.now() - started;
							let frame;
							if (t < 200) frame = 0;
							else if (t < 370) frame = 1;
							else if (t < 540) frame = 2;
							else if (t < 1640) frame = 3;
							else if (t < DAD_SEQ_MS) frame = 4;
							else frame = (t - DAD_SEQ_MS) % 2000 > 1750 ? 5 : 2; // blink loop
							display = { kind: 'image', src: ASSET(`dad-${frame}.png`), w: petH * 1.62, h: petH * 1.62 };
							mode = 'dad';
							break;
						}
						case 'error':
						{
							const d = machineRef.current.data;
							const errAt = d.errAt ?? Date.now();
							if (Date.now() - errAt < GRASS_MS) {
								// instant keypose: grass appears, stunned face
								display = { kind: 'image', src: ASSET('grass.png'), w: petH * 1.55, h: petH * 1.5 };
							} else {
								// failed narrative: daze → deflate → sit → lie down,
								// played ONCE and held on the final dazed frame
								const failAt = d.failAt ?? errAt + GRASS_MS;
								const n = clamp(Math.floor((Date.now() - failAt) / FAILED_MS), 0, LOOP.failed.frames - 1);
								display = { kind: 'frame', row: ROW.failed, col: n };
							}
							bubble = '握草！';
							mode = 'error';
							break;
						}
						default: display = { kind: 'anim', anim: 'idle' }; break;
					}
					displayRef.current = display;
					setPaint((prev) => (prev.mode === mode && prev.bubble === bubble ? prev : { mode, bubble }));
				};
				const timer = window.setInterval(step, 100);
				return () => window.clearInterval(timer);
			}, [petH]);

			// ---- drag / pat / double-click --------------------------------------
			const onPointerDown = (event) => {
				if (event.button !== 0) return;
				const stage = stageRef.current;
				if (!stage || !posRef.current) return;
				const start = { x: event.clientX, y: event.clientY, pos: { ...posRef.current } };
				let moved = false;
				let lastX = event.clientX;
				stage.dataset.dragging = 'true';
				stage.setPointerCapture(event.pointerId);
				const move = (ev) => {
					const vx = ev.clientX - lastX;
					lastX = ev.clientX;
					if (!moved && Math.abs(ev.clientX - start.x) + Math.abs(ev.clientY - start.y) <= 6) return;
					if (!moved) {
						moved = true;
						// rebase at the threshold: tracking starts smoothly,
						// without the initial 6px snap
						start.x = ev.clientX;
						start.y = ev.clientY;
						// being carried: legs run along the drag direction
						machineRef.current = { phase: 'drag', until: Infinity, data: { direction: vx >= 0 ? 1 : -1 } };
					} else if (vx > 0.5 || vx < -0.5) {
						const dir = vx > 0 ? 1 : -1;
						if (machineRef.current.phase === 'drag' && machineRef.current.data.direction !== dir) {
							machineRef.current.data.direction = dir;
						}
					}
					posRef.current = {
						x: clamp(start.pos.x + (ev.clientX - start.x), 4, Math.max(4, window.innerWidth - petW - 4)),
						y: clamp(start.pos.y + (ev.clientY - start.y), 4, Math.max(4, window.innerHeight - petH - 4)),
					};
					applyPosition();
				};
				const up = () => {
					stage.removeEventListener('pointermove', move);
					stage.removeEventListener('pointerup', up);
					stage.removeEventListener('pointercancel', up);
					delete stage.dataset.dragging;
					try {
						if (moved) window.localStorage.setItem(POS_KEY, JSON.stringify(posRef.current));
					} catch { /* ignore */ }
					if (!moved) {
						// a plain click (no drag) pats the pet: brief wave
						const m = machineRef.current;
						if (m.phase !== 'error' && m.phase !== 'dad') {
							machineRef.current = { phase: 'waving', until: Date.now() + 1300, data: { base: m.data.base ?? 'idle', waveAt: m.data.waveAt } };
						}
					} else if (machineRef.current.phase === 'drag') {
						// dropped: let the tick re-evaluate the real base state
						machineRef.current = { phase: 'idle', until: 0, data: { reschedule: true } };
					}
				};
				stage.addEventListener('pointermove', move);
				stage.addEventListener('pointerup', up);
				stage.addEventListener('pointercancel', up);
			};

			const onDoubleClick = () => {
				const m = machineRef.current;
				if (m.phase === 'error' || m.phase === 'dad') return;
				machineRef.current = { phase: 'jumping', until: Date.now() + 1300, data: { base: m.data.base ?? 'idle' } };
			};

			// ---- boot probe: stay hidden until assets are reachable ------------
			const [ready, setReady] = React.useState(false);
			React.useEffect(() => {
				let alive = true;
				const probe = async () => {
					try {
						const response = await fetch(ASSET('atlas.png'), { method: 'HEAD' });
						if (response.ok && alive) setReady(true);
					} catch { /* file:// or host missing: pet stays off */ }
				};
				probe();
				return () => { alive = false; };
			}, []);
			if (!ready) return null;

			// Bake the remembered position into the very first real render:
			// while the boot gate returned null, stageRef was null and the
			// layout effect could only fill posRef — mounting without this
			// would show the pet at top-left and teleport it on first drag.
			const stagePos = posRef.current ?? { x: window.innerWidth - petW - 26, y: window.innerHeight - petH - 14 };
			const stageStyle = {
				width: `${petW}px`,
				height: `${petH}px`,
				willChange: 'transform',
				transform: `translate(${stagePos.x}px, ${stagePos.y}px)`,
			};

			return h('div', { className: 'nuozi-pet-root' },
				h('style', null, CSS),
				h('div', {
					ref: stageRef,
					className: 'nuozi-pet-stage',
					style: stageStyle,
					'data-mode': paint.mode,
					title: '糯籽（拖动移动 · 双击跳跃）',
					onPointerDown,
					onDoubleClick,
				},
					paint.bubble ? h('div', { className: 'nuozi-pet-bubble', key: paint.bubble }, paint.bubble) : null,
					h('div', { ref: spriteRef, className: 'nuozi-pet-sprite', 'aria-hidden': 'true' }),
				),
			);
		}

		return {
			inject: ['slots'],
			apply(ctx) {
				// shell.overlay: frame-wide floating layer above every column;
				// only the pet body itself accepts pointer events.
				ctx.slots.inject('shell.overlay', () => ctx.slots.register(
					{ name: 'shell.overlay', id: 'nuozi-pet', order: 80, label: '糯籽 pet' },
					NuoziPet,
				));
			},
			// Surface-neutral atlas vocabulary for the desktop carrier
			// (desktop/pet-window.js). Exposed here so rows, frame counts, the
			// cell size and the 握草 staging keep exactly one definition across
			// both surfaces; the Client loader ignores properties it does not use.
			vocabulary: {
				cellW: CELL_W, cellH: CELL_H, atlasW: ATLAS_W, atlasH: ATLAS_H,
				row: ROW, loop: LOOP, look: LOOK_FRAMES,
				staging: { grassMs: GRASS_MS, failedMs: FAILED_MS },
			},
		};
	},
});
