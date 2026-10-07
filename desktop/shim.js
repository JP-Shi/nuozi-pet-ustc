// Minimal stand-in for the DSH Client module loader.
//
// client.js registers itself through window.__ModuleLoader__ and keeps its atlas
// vocabulary inside a factory closure. The desktop carrier needs that vocabulary
// and nothing else, so the shim captures the registration; pet-window.js then
// calls the factory once with a stub require. That call is side-effect free —
// the factory reads no React API until the component renders, and the desktop
// surface never renders it.

window.__ModuleLoader__ = {
	load(module) {
		window.__nuoziClientModule = module;
	},
};
