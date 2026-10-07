'use strict';

// Renderer bridge. The page never talks to the network itself: the main process
// owns both the DSH state poll and the cursor, so the custom pet:// origin stays
// fully offline and the sprite atlas can be sampled on a canvas without tainting.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('nuoziDesktop', {
	/** Report the sprite cell size taken from the Client half's vocabulary. */
	metrics: (value) => ipcRenderer.send('pet:metrics', value),
	/** Sprite scale request (0.3–1.2). The main process owns the value. */
	setScale: (scale) => ipcRenderer.send('pet:set-scale', scale),
	/** Hover hit-test result: true while the cursor is on the character. */
	interactive: (on) => ipcRenderer.send('pet:interactive', !!on),
	/** Anchor the upcoming drag at the button-down point, not at the threshold. */
	dragPrepare: () => ipcRenderer.send('pet:drag-prepare'),
	dragBegin: () => ipcRenderer.send('pet:drag-begin'),
	dragMove: () => ipcRenderer.send('pet:drag-move'),
	dragEnd: () => ipcRenderer.send('pet:drag-end'),
	/** Ask the main process to stroll the window (the pet's pacing). */
	stroll: (spec) => ipcRenderer.send('pet:stroll', spec),
	menu: () => ipcRenderer.send('pet:menu'),
	/** Boot report and throttled diagnostics for the opt-in startup trace. */
	ready: (info) => ipcRenderer.send('pet:ready', info),
	trace: (message) => ipcRenderer.send('pet:trace', message),

	onHostState: (cb) => ipcRenderer.on('pet:host-state', (_event, state) => cb(state)),
	onGeometry: (cb) => ipcRenderer.on('pet:geometry', (_event, geometry) => cb(geometry)),
	onStroll: (cb) => ipcRenderer.on('pet:stroll', (_event, state) => cb(state)),
	onDragDirection: (cb) => ipcRenderer.on('pet:drag-direction', (_event, direction) => cb(direction)),
	onCursor: (cb) => ipcRenderer.on('pet:cursor', (_event, point) => cb(point)),
});
