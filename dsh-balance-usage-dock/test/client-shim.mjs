/**
 * Test shim: gives `client.js` the browser globals it expects
 * (`window.__ModuleLoader__`, `ResizeObserver`, a stateful DOM storage), a
 * minimal React with refs and layout effects, and re-exports the captured
 * registration.
 *
 * Widths come from a fake layout table: any element carrying `data-width`
 * reports that width, so a test drives the responsive decision without a DOM.
 */

import fs from 'node:fs';

const registrations = new Map();
const seeds = [];
/** Width or ResizeObserver trigger for the next render, set by the test. */
let boxWidth = 0;
let observed = null;

/** Package name from the manifest: the id every registration must carry. */
export const packageName = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).name;

/** How wide the test says the observed root is. */
export function setBoxWidth(next) {
	boxWidth = next;
	if (observed !== null) observed(next);
}

/** Width of one rendered node, exactly as `widthOf` reads it in the browser. */
function fakeWidth(node) {
	if (node === null || node === undefined) return 0;
	return typeof node.getBoundingClientRect === 'function' ? node.getBoundingClientRect().width : 0;
}

const react = {
	createElement(type, props, ...children) {
		const element = { type, props: props ?? {}, children: children.flat() };
		// A committed DOM element answers `getBoundingClientRect`; the stand-in
		// answers with the width a test declared through `data-width`, or with the
		// observed box width when it is the root the ResizeObserver watches.
		const declared = props?.['data-width'];
		element.getBoundingClientRect = () => ({
			width: declared === undefined ? boxWidth : Number(declared),
		});
		// The stand-in resolves a ref synchronously, the way a committed ref would.
		if (typeof props?.ref === 'function') props.ref(element);
		else if (props?.ref !== null && typeof props?.ref === 'object') props.ref.current = element;
		return element;
	},
	Fragment: Symbol.for('react.fragment'),
	memo(component) {
		// The stand-in renders eagerly, so a memoized component renders here too.
		return function memoized(props) {
			return component(props);
		};
	},
	useRef(initial) {
		return { current: initial ?? null };
	},
	// The component reads its state through fixed slots in a fixed order, so a
	// test seeds them positionally: payload, observed width, part widths.
	useState(initial) {
		return [seeds.length > 0 ? seeds.shift() : typeof initial === 'function' ? initial() : initial, () => {}];
	},
	useMemo(factory) {
		return factory();
	},
	useEffect() {},
	// Layout effects run inline, so the measurement pass completes in the render
	// the test drives.
	useLayoutEffect(effect) {
		const cleanup = effect();
		if (typeof cleanup === 'function') cleanup();
	},
};

/** Seed the next `useState` call, so a component renders a chosen payload. */
export function seedState(value) {
	seeds.push(value);
}

globalThis.window = {
	__ModuleLoader__: {
		load(registration) {
			// The real loader rejects a second registration; the shim records it
			// so a double execution is visible as a repeated id.
			if (registrations.has(registration.id)) {
				throw new Error(`duplicate factory registration for "${registration.id}"`);
			}
			registrations.set(registration.id, registration);
		},
	},
	localStorage: (() => {
		const values = new Map();
		return {
			getItem: (key) => (values.has(key) ? values.get(key) : null),
			setItem: (key, value) => values.set(key, String(value)),
			removeItem: (key) => values.delete(key),
			clear: () => values.clear(),
		};
	})(),
};

/** The observed element reports `boxWidth`; a test sets it before rendering. */
globalThis.ResizeObserver = class ResizeObserver {
	constructor(callback) {
		this.callback = callback;
	}
	observe(node) {
		observed = (width) => {
			boxWidth = width;
			this.callback([{ contentRect: { width } }]);
		};
		boxWidth = fakeWidth(node) || boxWidth;
	}
	disconnect() {
		observed = null;
	}
};

/** Read a node's rendered width the way the component does. */
export function nodeWidth(node) {
	return fakeWidth(node);
}

// The browser language is the last fallback for the dock's copy, so the shim
// stands in for a Chinese browser the way a real page would.
if (globalThis.navigator === undefined) globalThis.navigator = { language: 'zh-CN' };

/** The browser module table this plugin is allowed to request. */
function loadModule(specifier) {
	if (specifier === 'react') return react;
	throw new Error(`unexpected module request: ${specifier}`);
}

await import('../client.js');

export const registration = registrations.get(packageName);
if (registration === undefined) {
	throw new Error(
		`client.js registered ${JSON.stringify([...registrations.keys()])} but the boot graph expects "${packageName}"`,
	);
}

export const plugin = registration.factory(loadModule);
export const registrationCount = registrations.size;
export { react };
