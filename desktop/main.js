// Desktop carrier for 糯籽 (Nuozi): the same pet in an operating-system window.
//
// The Client half normally renders into the DSH Web GUI's shell.overlay slot,
// which confines the pet to the application window. This carrier gives it a
// window of its own — frameless, transparent, always on top, absent from the
// taskbar — and keeps it click-through everywhere except the character's pixels.
//
// It is a second consumer of what the plugin already publishes:
//
//   GET /nuozi-pet/state   working / waiting / error / userAt / cfg
//   assets/atlas.png       the sprite sheet, read from this package
//
// and it loads the Client half (client.js) through a minimal loader shim to
// borrow the atlas vocabulary, so rows, frame counts, cell size and timings have
// exactly one definition. Everything window-specific — transparency, click
// through, dragging, resizing, positioning — lives here and in pet-window.js.
//
// Run with `npm run desktop`. See README.md for the endpoint it polls.

import { app, BrowserWindow, Menu, ipcMain, protocol, screen } from 'electron';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
/** Package root: client.js, assets/ and desktop/ all live under it. */
const PACKAGE_ROOT = resolve(HERE, '..');
const ENTRY = 'desktop/index.html';

/** Transparent margin around the sprite so its drop shadow is not clipped. */
const SHADOW_PAD = 16;
/** Used only until the renderer reports the real cell size from client.js. */
const FALLBACK_CELL = { w: 192, h: 208 };
const SCALE_MIN = 0.3;
const SCALE_MAX = 1.2;
const SCALE_DEFAULT = 0.55;
const POLL_MS = 1000;
const CURSOR_MS = 50;
/**
 * A drag ends if the renderer stops reporting for this long. The renderer sends
 * a keepalive while the button is held, so holding the pet still does not end the
 * drag; only a genuinely lost pointerup does.
 */
const DRAG_IDLE_MS = 1500;

const WINDOW_TITLE = '糯籽桌面宠物';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
};

/** DSH Web UI to read work state from. 3080 is DSH's own default port. */
const DSH_BASE = (process.env.NUOZI_DSH_BASE || 'http://127.0.0.1:3080').replace(/\/+$/u, '');
const STATE_URL = `${DSH_BASE}/nuozi-pet/state`;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const clampScale = (value) => clamp(Math.round(Number(value) * 100) / 100 || SCALE_DEFAULT, SCALE_MIN, SCALE_MAX);

// One same-origin scheme for the page, the Client half and the atlas: a file://
// page would taint the canvas that the alpha hit test needs.
protocol.registerSchemesAsPrivileged([
  { scheme: 'pet', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

/** @type {BrowserWindow | null} */
let win = null;
let cell = { ...FALLBACK_CELL };
let scale = SCALE_DEFAULT;
let pad = SHADOW_PAD;
let hostState = { ok: false, working: false, waiting: false, error: null, userAt: null, cfg: {}, rev: 0, at: 0 };
let interactive = false;
/** @type {null | { bounds: Electron.Rectangle, cursor: { x: number, y: number } }} */
let press = null;
/** @type {null | Record<string, any>} */
let drag = null;
/** @type {null | Record<string, any>} */
let stroll = null;
let strollTimer = null;
let pollTimer = null;
let cursorTimer = null;
let lastCursor = { x: Number.NaN, y: Number.NaN };
/** Keeps the window interactive while a context menu is open. */
let menuOpen = false;
let revealed = false;

/**
 * Opt-in startup trace. A GUI process on Windows has no usable console, and a
 * transparent frameless window gives no other way to see where it stopped.
 * @param {string} message
 */
function debug(message) {
  const target = process.env.NUOZI_DEBUG_LOG;
  if (!target) return;
  try {
    writeFileSync(target, `${new Date().toISOString()} ${message}\n`, { flag: 'a' });
  } catch {
    /* diagnostics never affect the pet */
  }
}

process.on('uncaughtException', (error) => debug(`uncaughtException: ${error?.stack ?? error}`));
process.on('unhandledRejection', (reason) => debug(`unhandledRejection: ${reason?.stack ?? reason}`));

// ---- geometry --------------------------------------------------------------

/** Window size derived from the sprite cell reported by the Client half. */
function geometry() {
  const petW = Math.round(cell.w * scale);
  const petH = Math.round(cell.h * scale);
  return {
    scale,
    cellW: cell.w,
    cellH: cell.h,
    pad,
    petW,
    petH,
    width: petW + pad * 2,
    height: petH + pad * 2,
  };
}

function workAreaFor(x, y, width, height) {
  const display = screen.getDisplayNearestPoint({ x: Math.round(x + width / 2), y: Math.round(y + height / 2) });
  return display.workArea;
}

function clampToWorkArea(x, y, width, height) {
  const area = workAreaFor(x, y, width, height);
  return {
    x: clamp(Math.round(x), area.x, area.x + Math.max(0, area.width - width)),
    y: clamp(Math.round(y), area.y, area.y + Math.max(0, area.height - height)),
  };
}

function defaultPosition(width, height) {
  const area = screen.getPrimaryDisplay().workArea;
  return { x: area.x + area.width - width - 28, y: area.y + area.height - height - 16 };
}

/**
 * Move the window without ever letting its size be derived from the window.
 *
 * `setPosition` and `setBounds(getBounds()…, x)` both round-trip the size through
 * the display scale factor, which on a 150% display gains a pixel per call: the
 * window visibly creeps, and because the work-area clamp subtracts the (now
 * larger) height it is pushed steadily toward the top-left corner. Passing the
 * authoritative size every time makes each move idempotent.
 *
 * @param {number} x
 * @param {number} y
 * @returns {{ x: number, y: number } | null} the position actually applied
 */
function moveWindow(x, y) {
  if (!win || win.isDestroyed()) return null;
  const geo = geometry();
  const position = clampToWorkArea(x, y, geo.width, geo.height);
  win.setBounds({ x: position.x, y: position.y, width: geo.width, height: geo.height });
  return position;
}

// ---- placement memory ------------------------------------------------------

const stateFile = () => join(app.getPath('userData'), 'nuozi-desktop-pet.json');

function readSaved() {
  try {
    const parsed = JSON.parse(readFileSync(stateFile(), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function writeSaved(patch) {
  try {
    mkdirSync(dirname(stateFile()), { recursive: true });
    writeFileSync(stateFile(), JSON.stringify({ ...(readSaved() ?? {}), ...patch }, null, 2));
  } catch {
    /* remembering where the pet sits is a convenience, never fatal */
  }
}

// ---- window ----------------------------------------------------------------

function createWindow() {
  const geo = geometry();
  const saved = readSaved();
  const fallback = defaultPosition(geo.width, geo.height);
  const position = clampToWorkArea(
    Number.isFinite(saved?.x) ? saved.x : fallback.x,
    Number.isFinite(saved?.y) ? saved.y : fallback.y,
    geo.width,
    geo.height,
  );

  win = new BrowserWindow({
    ...position,
    width: geo.width,
    height: geo.height,
    title: WINDOW_TITLE,
    transparent: true,
    frame: false,
    hasShadow: false,
    backgroundColor: '#00000000',
    resizable: false, // the sprite owns the size; scaling goes through setScale()
    movable: false, // moved explicitly so drag, clamp and strolling stay here
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    acceptFirstMouse: true,
    show: false,
    webPreferences: {
      // .cjs on purpose: the package is ESM, and an ESM preload would require
      // sandbox: false and lose the bridge guarantees a preload is for.
      preload: join(HERE, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  // 'screen-saver' is the highest documented level: above full-screen apps.
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  applyIgnore();
  win.setMenuBarVisibility(false);

  // The Client half's <title> would otherwise replace the window title that
  // external tooling uses to identify this window.
  win.on('page-title-updated', (event) => event.preventDefault());
  win.on('closed', () => {
    debug('window closed');
    win = null;
  });
  win.webContents.on('did-fail-load', (_event, code, description, url) => {
    debug(`did-fail-load ${code} ${description} ${url}`);
  });
  win.webContents.on('console-message', (_event, level, message) => debug(`renderer[${level}] ${message}`));
  win.webContents.on('did-finish-load', () => {
    debug('did-finish-load');
    win?.webContents.send('pet:host-state', hostState);
  });

  debug(`loading ${ENTRY} at ${position.x},${position.y} ${geo.width}x${geo.height}`);
  win.loadURL(`pet://nuozi/${ENTRY}`).catch((error) => debug(`loadURL failed: ${error?.message ?? error}`));
}

/**
 * Reveal the window once the Client half has reported its real cell size, so it
 * never flashes at the fallback geometry.
 */
function reveal() {
  if (revealed || !win || win.isDestroyed()) return;
  revealed = true;
  win.showInactive();
  win.setSkipTaskbar(true);
  debug(`revealed ${JSON.stringify(geometry())}`);
}

/**
 * Click-through switch. Mouse *move* events are not relied on while the window
 * ignores input (the OS routes them elsewhere), which is why the cursor is
 * polled in the main process instead.
 */
function applyIgnore() {
  if (!win || win.isDestroyed()) return;
  const ignore = !(interactive || drag !== null || menuOpen);
  win.setIgnoreMouseEvents(ignore, { forward: true });
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// ---- scaling ---------------------------------------------------------------

/**
 * Resize the sprite, keeping its bottom centre anchored so the pet grows and
 * shrinks in place instead of jumping across the screen.
 * @param {number} next requested scale, clamped to SCALE_MIN..SCALE_MAX
 */
function setScale(next) {
  const value = clampScale(next);
  const before = geometry();
  if (Math.abs(value - scale) < 0.001) return;
  const bounds = win && !win.isDestroyed() ? win.getBounds() : null;
  const centreX = bounds ? bounds.x + before.width / 2 : 0;
  const bottom = bounds ? bounds.y + before.height - before.pad : 0;

  scale = value;
  const after = geometry();
  if (!bounds) return;

  const position = clampToWorkArea(centreX - after.width / 2, bottom - (after.height - after.pad), after.width, after.height);
  win.setBounds({ x: position.x, y: position.y, width: after.width, height: after.height });
  send('pet:geometry', after);
  writeSaved({ x: position.x, y: position.y, scale });
}

// ---- dragging --------------------------------------------------------------

function applyDragPosition() {
  if (!win || !drag) return;
  const cursor = screen.getCursorScreenPoint();
  if (cursor.x !== drag.lastX) {
    const direction = cursor.x > drag.lastX ? 1 : -1;
    if (direction !== drag.direction) {
      drag.direction = direction;
      send('pet:drag-direction', direction);
    }
    drag.lastX = cursor.x;
  }
  moveWindow(drag.startBounds.x + (cursor.x - drag.startX), drag.startBounds.y + (cursor.y - drag.startY));
}

function dragTick() {
  if (!drag) return;
  applyDragPosition();
  if (Date.now() - drag.lastAt > DRAG_IDLE_MS) endDrag();
}

/**
 * Record where the button went down, before the renderer's drag threshold is
 * crossed. Anchoring the drag here is what makes tracking 1:1 from the press
 * point; anchoring it at the moment the threshold is crossed would silently drop
 * every pixel moved up to that moment.
 *
 * The cursor is read here rather than taken from the renderer's MouseEvent
 * coordinates, which are CSS pixels and drift from these DIP coordinates when
 * displays use different scale factors.
 */
function prepareDrag() {
  if (!win || win.isDestroyed()) return;
  const cursor = screen.getCursorScreenPoint();
  press = { bounds: win.getBounds(), cursor };
  debug(`drag prepare bounds=${JSON.stringify(press.bounds)} cursor=${cursor.x},${cursor.y}`);
}

function beginDrag() {
  if (!win || drag) return;
  // A stroll already running would fight the drag for the same window position.
  endStroll();
  const cursor = screen.getCursorScreenPoint();
  const origin = press ?? { bounds: win.getBounds(), cursor };
  press = null;
  drag = {
    startBounds: origin.bounds,
    startX: origin.cursor.x,
    startY: origin.cursor.y,
    lastX: cursor.x,
    direction: 1,
    lastAt: Date.now(),
    timer: setInterval(dragTick, 16),
  };
  debug(`drag begin bounds=${JSON.stringify(drag.startBounds)} cursor=${drag.startX},${drag.startY}`);
  applyIgnore();
  applyDragPosition();
}

function moveDrag() {
  if (!drag) return;
  drag.lastAt = Date.now();
  applyDragPosition();
}

function endDrag() {
  press = null;
  if (!drag) return;
  clearInterval(drag.timer);
  drag = null;
  const bounds = win && !win.isDestroyed() ? win.getBounds() : null;
  if (bounds) writeSaved({ x: bounds.x, y: bounds.y, scale });
  // Re-report the cursor so click-through is decided from where the pet ended up.
  lastCursor = { x: Number.NaN, y: Number.NaN };
  applyIgnore();
}

// ---- strolling (the pet's own pacing) --------------------------------------

function sendStroll(moving, dir) {
  send('pet:stroll', { moving, dir });
}

function strollTick() {
  if (!win || !stroll) return;
  if (stroll.phase === 'pause') {
    if (Date.now() >= stroll.pauseUntil) {
      stroll.phase = 'back';
      stroll.targetX = stroll.anchorX;
      sendStroll(false, stroll.dir);
    }
    return;
  }
  const geo = geometry();
  const bounds = win.getBounds();
  const area = workAreaFor(stroll.x, bounds.y, geo.width, geo.height);
  const target = clamp(stroll.targetX, area.x, area.x + Math.max(0, area.width - geo.width));
  const delta = target - stroll.x;
  const stepPx = stroll.speed * 0.016;
  if (Math.abs(delta) <= stepPx) {
    stroll.x = Math.round(target);
    moveWindow(stroll.x, bounds.y);
    if (stroll.phase === 'back') {
      endStroll();
    } else {
      stroll.phase = 'pause';
      stroll.pauseUntil = Date.now() + 1500 + Math.random() * 1500;
      sendStroll(false, stroll.dir);
    }
    return;
  }
  stroll.moving = true;
  stroll.dir = delta > 0 ? 1 : -1;
  // The stroll owns its x rather than reading it back: a value that only ever
  // moves by a rounded step cannot accumulate rounding error.
  stroll.x = Math.round(stroll.x + stroll.dir * stepPx);
  moveWindow(stroll.x, bounds.y);
  sendStroll(true, stroll.dir);
}

function endStroll() {
  if (strollTimer) clearInterval(strollTimer);
  strollTimer = null;
  stroll = null;
  sendStroll(false, 1);
  const bounds = win && !win.isDestroyed() ? win.getBounds() : null;
  if (bounds) writeSaved({ x: bounds.x, y: bounds.y, scale });
}

function beginStroll(spec) {
  // Never walk out from under the cursor: a pet the user is pointing at stays put.
  if (!win || drag || stroll || interactive) return;
  const geo = geometry();
  const bounds = win.getBounds();
  const area = workAreaFor(bounds.x, bounds.y, geo.width, geo.height);
  const range = clamp(Number(spec?.range) || 0, -400, 400);
  const targetX = clamp(bounds.x + range, area.x, area.x + Math.max(0, area.width - geo.width));
  if (Math.abs(targetX - bounds.x) < 12) return;
  stroll = {
    anchorX: bounds.x,
    x: bounds.x,
    targetX,
    speed: clamp(Number(spec?.speed) || 55, 20, 120),
    phase: 'out',
    pauseUntil: 0,
    moving: true,
    dir: range > 0 ? 1 : -1,
  };
  strollTimer = setInterval(strollTick, 16);
}

// ---- host state ------------------------------------------------------------

async function pollHost() {
  try {
    const response = await fetch(STATE_URL, { cache: 'no-store', signal: AbortSignal.timeout(1500) });
    if (!response.ok) throw new Error(String(response.status));
    const body = await response.json();
    hostState = {
      ok: true,
      working: !!body.working,
      waiting: !!body.waiting,
      error: body.error ?? null,
      userAt: Number.isFinite(body.userAt) ? body.userAt : null,
      cfg: body.cfg ?? {},
      rev: Number.isFinite(body.rev) ? body.rev : 0,
      at: Date.now(),
    };
    // The plugin's config owns the default scale until the user resizes the pet.
    if (!readSaved() && Number.isFinite(hostState.cfg.scale)) setScale(hostState.cfg.scale);
  } catch {
    const wasOnline = hostState.ok;
    // An unreachable host is the offline case. It only counts as 断网 once the
    // pet has actually seen the host: a carrier started with no DSH running must
    // sit quiet, not 握草 forever.
    hostState = {
      ...hostState,
      ok: false,
      error: wasOnline ? { kind: 'offline', at: Date.now(), detail: 'state endpoint unreachable' } : hostState.error,
      at: Date.now(),
    };
  }
  send('pet:host-state', hostState);
}

/**
 * Poll the cursor instead of trusting forwarded mouse events: while the window
 * ignores input the OS delivers those with coordinates that cannot be trusted,
 * and a single stale sample would flip a deliberate click-through decision.
 */
function pollCursor() {
  if (!win || win.isDestroyed()) return;
  const point = screen.getCursorScreenPoint();
  if (point.x === lastCursor.x && point.y === lastCursor.y) return;
  lastCursor = { x: point.x, y: point.y };
  const bounds = win.getBounds();
  send('pet:cursor', { x: point.x - bounds.x, y: point.y - bounds.y });
}

// ---- context menu ----------------------------------------------------------

function openMenu() {
  if (!win) return;
  const sizes = [
    { label: '小', value: 0.4 },
    { label: '中', value: 0.55 },
    { label: '大', value: 0.8 },
    { label: '特大', value: 1.1 },
  ];
  const menu = Menu.buildFromTemplate([
    {
      label: '大小',
      submenu: sizes.map((entry) => ({
        label: `${entry.label}（${Math.round(entry.value * 100)}%）`,
        type: 'radio',
        checked: Math.abs(scale - entry.value) < 0.001,
        click: () => setScale(entry.value),
      })),
    },
    { label: '提示：把光标放在糯籽上滚动滚轮也可缩放', enabled: false },
    { type: 'separator' },
    {
      label: '总在最前',
      type: 'checkbox',
      checked: win.isAlwaysOnTop(),
      click: (item) => win?.setAlwaysOnTop(item.checked, 'screen-saver'),
    },
    {
      label: '回到右下角',
      click: () => {
        if (!win) return;
        const geo = geometry();
        const position = defaultPosition(geo.width, geo.height);
        win.setBounds({ x: position.x, y: position.y, width: geo.width, height: geo.height });
        writeSaved({ x: position.x, y: position.y, scale });
      },
    },
    { type: 'separator' },
    { label: '糯籽 · 形象作者 @JP-Shi', enabled: false },
    { label: '退出', click: () => app.quit() },
  ]);
  menuOpen = true;
  menu.once('menu-will-close', () => {
    menuOpen = false;
    applyIgnore();
  });
  menu.popup({ window: win });
}

// ---- renderer bridge -------------------------------------------------------

function registerIpc() {
  ipcMain.on('pet:metrics', (_event, metrics) => {
    const cellW = Number(metrics?.cellW);
    const cellH = Number(metrics?.cellH);
    if (!Number.isFinite(cellW) || !Number.isFinite(cellH) || cellW <= 0 || cellH <= 0) return;
    cell = { w: cellW, h: cellH };
    if (Number.isFinite(metrics?.pad) && metrics.pad > 0) pad = metrics.pad;
    const geo = geometry();
    if (win && !win.isDestroyed()) {
      const bounds = win.getBounds();
      const position = clampToWorkArea(bounds.x, bounds.y, geo.width, geo.height);
      win.setBounds({ x: position.x, y: position.y, width: geo.width, height: geo.height });
      win.webContents.send('pet:geometry', geo);
    }
    // Not revealed here: the window waits for the atlas (see pet:ready) so the
    // first thing on screen is the pet, not an empty transparent window.
  });
  ipcMain.on('pet:interactive', (_event, on) => {
    interactive = !!on;
    applyIgnore();
  });
  ipcMain.on('pet:set-scale', (_event, value) => setScale(value));
  ipcMain.on('pet:drag-prepare', () => prepareDrag());
  ipcMain.on('pet:drag-begin', () => beginDrag());
  ipcMain.on('pet:drag-move', () => moveDrag());
  ipcMain.on('pet:drag-end', () => endDrag());
  ipcMain.on('pet:stroll', (_event, spec) => beginStroll(spec));
  ipcMain.on('pet:menu', () => openMenu());
  ipcMain.on('pet:ready', (_event, info) => {
    debug(`renderer ready ${JSON.stringify(info)} bounds=${JSON.stringify(win?.getBounds())}`);
    // The Client half reports the decoded atlas size here; reveal once the sprite
    // can actually paint.
    if (typeof info?.atlas === 'string' && info.atlas.includes('x')) reveal();
  });
  ipcMain.on('pet:trace', (_event, message) => debug(`renderer: ${message}`));
}

// ---- package files over pet:// ---------------------------------------------

async function serve(request) {
  const url = new URL(request.url);
  const relative = decodeURIComponent(url.pathname).replace(/^\/+/u, '') || ENTRY;
  const file = resolve(PACKAGE_ROOT, relative);
  if (file !== PACKAGE_ROOT && !file.startsWith(PACKAGE_ROOT + sep)) {
    return new Response('forbidden', { status: 403 });
  }
  try {
    const content = await readFile(file);
    return new Response(content, {
      status: 200,
      headers: {
        // Explicit MIME types: a wrong one silently blocks a classic script.
        'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
        'cache-control': 'no-store',
      },
    });
  } catch {
    return new Response('not found', { status: 404 });
  }
}

// ---- boot ------------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    reveal();
    win.setAlwaysOnTop(true, 'screen-saver');
  });

  app.on('window-all-closed', () => app.quit());

  app.on('before-quit', () => {
    if (strollTimer) clearInterval(strollTimer);
    if (pollTimer) clearInterval(pollTimer);
    if (cursorTimer) clearInterval(cursorTimer);
    if (drag) clearInterval(drag.timer);
  });

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    registerIpc();
    protocol.handle('pet', serve);

    const saved = readSaved();
    if (Number.isFinite(saved?.scale)) scale = clampScale(saved.scale);

    createWindow();
    lastCursor = { x: Number.NaN, y: Number.NaN };
    cursorTimer = setInterval(pollCursor, CURSOR_MS);

    // Never leave the pet invisible if the Client half cannot report metrics.
    setTimeout(reveal, 1500);

    screen.on('display-metrics-changed', () => {
      if (!win || drag) return;
      const geo = geometry();
      const bounds = win.getBounds();
      const position = clampToWorkArea(bounds.x, bounds.y, geo.width, geo.height);
      win.setBounds({ x: position.x, y: position.y, width: geo.width, height: geo.height });
    });

    await pollHost();
    pollTimer = setInterval(pollHost, POLL_MS);
  });
}
