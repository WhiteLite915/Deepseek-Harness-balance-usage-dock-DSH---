/**
 * Local checks for the browser half: the registered slot entry, the payload
 * states, and the balance/usage rendering. React is a minimal stand-in, so
 * this validates structure and copy rather than pixels.
 */
import { plugin, registration, seedState, packageName, registrationCount, setBoxWidth } from './client-shim.mjs';

const failures = [];
function check(label, condition, detail) {
	if (condition) {
		console.log(`  ok   ${label}`);
		return;
	}
	failures.push(label);
	console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
}

/** Walk a rendered tree, collecting text, element types, titles and parts. */
function walk(node, out = { texts: [], types: [], titles: [], parts: [] }) {
	if (node === null || node === undefined || typeof node === 'boolean') return out;
	if (typeof node === 'string' || typeof node === 'number') {
		out.texts.push(String(node));
		return out;
	}
	if (Array.isArray(node)) {
		for (const child of node) walk(child, out);
		return out;
	}
	if (typeof node !== 'object') return out;
	if (typeof node.type === 'function') {
		// A memoized or ordinary component: render it through the stand-in.
		walk(node.type(node.props ?? {}), out);
		return out;
	}
	out.types.push(String(node.type));
	if (typeof node.props?.title === 'string') out.titles.push(node.props.title);
	if (typeof node.props?.['data-parts'] === 'string') out.parts.push(node.props['data-parts']);
	// React elements carry children on `props.children`; the stand-in also keeps
	// a `children` field pointing at the same array, so walk each one once.
	walk(node.props?.children, out);
	if (node.children !== node.props?.children) walk(node.children, out);
	return out;
}

/**
 * Render one state the way the slot renderer would.
 *
 * The real renderer turns the entry's `hooks` sources into selector hooks and
 * merges any other injected field as a plain prop. `boxWidth` is the width the
 * composer row gives the dock, `sessionId` is the session key a session-scoped
 * slot passes to `inject`, and `useHooks`/`locale` select which of the two
 * locale channels this render exercises.
 *
 * A browser commits the observed box width and the measured part widths through
 * a second render; the first pass here reads them out of the measurement layer
 * and the second pass replays that commit with the state a browser would hold.
 */
function render(payload, locale = 'zh-CN', options = {}) {
	const injected = registered.entry.options.inject?.(options.sessionId) ?? {};
	const props = { ...injected };
	delete props.hooks;
	if (options.useHooks !== false && injected.hooks?.locale !== undefined) {
		props.useLocale = (select) => select(injected.hooks.locale.getSnapshot());
	}
	if (locale !== undefined) props.locale = locale;
	const boxWidth = options.boxWidth ?? 0;
	setBoxWidth(boxWidth);

	seedState(payload);
	const first = Dock(props);
	const widths = measureWidthsOf(first);
	if (options.measure === false) {
		const plain = walk(first);
		return { tree: first, ...plain, text: plain.texts.join(' | '), title: plain.titles.join(' | '), parts: plain.parts.at(-1), chart: [] };
	}
	seedState(payload);
	seedState(boxWidth);
	seedState(widths);
	const tree = Dock(props);
	const walked = walk(tree);
	return {
		tree,
		...walked,
		text: walked.texts.join(' | '),
		title: walked.titles.join(' | '),
		parts: walked.parts.at(-1),
		// Elements inside the visible row only; the measurement layer draws a
		// throwaway copy of the chart.
		chart: visibleChart(tree),
	};
}

/** Element types inside the visible dock row (the one carrying `data-parts`). */
function visibleChart(tree) {
	const row = findRow(tree);
	return row === undefined ? [] : walk(row).types;
}

/** Find the visible dock row: the only element carrying `data-parts`. */
function findRow(node) {
	if (node === null || typeof node !== 'object') return undefined;
	if (Array.isArray(node)) {
		for (const child of node) {
			const found = findRow(child);
			if (found !== undefined) return found;
		}
		return undefined;
	}
	if (typeof node.props?.['data-parts'] === 'string') return node;
	return findRow(node.props?.children) ?? (node.children === node.props?.children ? undefined : findRow(node.children));
}

/** The part widths the measurement layer declared, as a browser would measure them. */
function measureWidthsOf(tree) {
	let widths = { balance: 0, today: 0, chart: 0 };
	const visit = (node) => {
		if (node === null || typeof node !== 'object') return;
		if (Array.isArray(node)) {
			for (const child of node) visit(child);
			return;
		}
		if (node.props?.className === 'dshbud_measure') {
			const parts = node.props.children ?? node.children ?? [];
			const list = Array.isArray(parts) ? parts : [parts];
			widths = {
				balance: Number(list[0]?.props?.['data-width'] ?? 0),
				today: Number(list[1]?.props?.['data-width'] ?? 0),
				chart: Number(list[2]?.props?.['data-width'] ?? 0),
			};
		}
		visit(node.props?.children);
		if (node.children !== node.props?.children) visit(node.children);
	};
	visit(tree);
	return widths;
}

console.log('registration');
// The loader checks `factories.has(packageName)` after a bundle script runs; a
// different id makes it execute the bundle a second time and fail the boot.
check('factory id is the package name', registration.id === packageName, { id: registration.id, packageName });
check('the bundle registered exactly once', registrationCount === 1, registrationCount);
check('module injects slots', Array.isArray(plugin.inject) && plugin.inject.includes('slots'), plugin.inject);

let registered;
const localeSnapshot = { active: 'zh-CN', locales: [], revision: 1 };
let localeSubscribers = 0;
const localeSource = {
	getSnapshot: () => localeSnapshot,
	subscribe(listener) {
		localeSubscribers++;
		return () => {
			localeSubscribers--;
		};
	},
};
let slotRegistrations = 0;
plugin.apply({
	slots: {
		inject(key, factory) {
			registered = { key, entry: factory() };
		},
		register(options, component) {
			slotRegistrations++;
			return { options, component, dispose() {} };
		},
	},
	get: (name) => (name === 'locale' ? localeSource : undefined),
});
check('registers into the composer dock', registered?.key === 'conversation.composer.dock', registered?.key);
check('exactly one slot entry', slotRegistrations === 1, slotRegistrations);
check('entry id is the plugin id', registered?.entry?.options?.id === 'balance-usage-dock', registered?.entry?.options);
check(
	'entry sorts left of the host pills',
	registered?.entry?.options?.priority === -1 && registered?.entry?.options?.order === -10,
	registered?.entry?.options,
);
// A static `locale` prop would freeze the provisional browser language; the
// subscribe-able source must be exposed as a hook instead.
check('locale is injected as a hook source', registered?.entry?.options?.inject?.()?.hooks?.locale === localeSource, registered?.entry?.options?.inject?.());

const Dock = registered.entry.component;

/** A wide row: the dock has room for every part. */
const WIDE = 520;
/** A narrow row: only the balance fits. */
const NARROW = 300;

console.log('empty state');
// Before the first read the dock draws only its off-screen measurement layer.
const beforeRead = render(null, 'zh-CN', { boxWidth: WIDE });
check('draws no visible row before the first read', beforeRead.parts === undefined, beforeRead.parts);

const ready = {
	status: 'ready',
	currency: 'CNY',
	symbol: '¥',
	balance: 46.8334,
	balanceText: '¥46.83',
	wallets: [
		{ currency: 'CNY', amount: 42.5, display: '¥42.50' },
		{ currency: 'CNY', amount: 4.3334, display: '¥4.33' },
	],
	isSplit: true,
	cost: 108.82995698,
	spentText: '¥0.42',
	timezoneOffsetMinutes: 480,
	responses: [
		{ total: 5400, output: 1200, input: 4200 },
		{ total: 12800, output: 9600, input: 3200 },
		{ total: 3100, output: 900, input: 2200 },
	],
	updatedAt: Date.now(),
};

console.log('ready state');
globalThis.window.localStorage.clear();
const view = render(ready, 'zh-CN', { boxWidth: WIDE });
check('shows the balance label', view.text.includes('余额'), view.text);
check('shows the balance value', view.text.includes('¥46.83'), view.text);
check('shows the today label', view.text.includes('今日'), view.text);
check('shows the usage label', view.text.includes('用量'), view.text);
check('draws one bar per response', view.chart.filter((type) => type === 'rect').length === 3, view.chart.filter((type) => type === 'rect').length);
check('draws the chart baseline', view.chart.includes('line'), view.chart);
check('draws no spend line', !view.chart.includes('polyline'), view.chart);
check('injects one stylesheet', view.types.filter((type) => type === 'style').length === 1, view.types);
check('starts the day baseline', globalThis.window.localStorage.getItem('dsh-balance-usage-dock:day') !== null);
check('tooltip counts the responses', view.title.includes('第 3 次回复'), view.title);
check('tooltip splits output and input', view.title.includes('输出 900 · 输入 2.2k'), view.title);
check('tooltip carries the session spend', view.title.includes('本次会话已消耗 ¥0.42'), view.title);

console.log('responsive order: chart first, then today, balance always');
const wide = render(ready, 'zh-CN', { boxWidth: WIDE });
check('a wide row shows every part', wide.parts === 'today+chart', wide.parts);
const medium = render(ready, 'zh-CN', { boxWidth: 380 });
check('a medium row drops the chart only', medium.parts === 'today', medium.parts);
check('the dropped chart is really gone', !medium.chart.includes('rect'), medium.chart);
check('the today figure survives', medium.text.includes('今日'), medium.text);
const narrow = render(ready, 'zh-CN', { boxWidth: NARROW });
check('a narrow row drops the chart and today', narrow.parts === 'balance', narrow.parts);
check('the balance always survives', narrow.text.includes('余额') && narrow.text.includes('¥46.83'), narrow.text);
check('no chart element survives a narrow row', !narrow.chart.includes('rect') && !narrow.chart.includes('svg'), narrow.chart);
check('the tooltip keeps the hidden figures', narrow.title.includes('今日') && narrow.title.includes('第 3 次回复'), narrow.title);

console.log('wallet split');
// The headline must be the sum of the wallet rows as the account page shows
// them; the tooltip carries the exact total and the split behind it.
const split = render({
	...ready,
	balance: 24.59499999,
	balanceText: '¥24.59',
	wallets: [
		{ currency: 'CNY', amount: 22.835, shown: 22.83, display: '¥22.83' },
		{ currency: 'CNY', amount: 1.75999999, shown: 1.75, display: '¥1.75' },
	],
}, 'zh-CN', { boxWidth: WIDE });
check('headline uses the Host display text', split.text.includes('¥24.59'), split.text);
check('a third decimal of five or more never rounds the wallet up', !split.text.includes('¥24.61'), split.text);
check('tooltip keeps the unrounded total', split.title.includes('¥24.59'), split.title);
check('tooltip shows the wallet split', split.title.includes('¥22.83 + ¥1.75'), split.title);

// A payload without Host text must reproduce the same truncation locally.
const local = render({
	...ready,
	balance: 24.59499999,
	balanceText: undefined,
	wallets: [
		{ currency: 'CNY', amount: 22.835, exact: '22.8350000000000000', shown: 22.83, display: '¥22.83' },
		{ currency: 'CNY', amount: 1.765, exact: '1.7650000000000000', shown: 1.76, display: '¥1.76' },
	],
}, 'zh-CN', { boxWidth: WIDE });
check('the local sum matches the Host text', local.text.includes('¥24.59'), local.text);
check('the local sum never rounds up to 24.61', !local.text.includes('¥24.61'), local.text);

const single = render({
	...ready,
	wallets: [{ currency: 'CNY', amount: 46.8334, shown: 46.83, display: '¥46.83' }],
	isSplit: false,
}, 'zh-CN', { boxWidth: WIDE });
check('a single wallet shows no split', !single.title.includes('+'), single.title);

const naive = render({ ...ready, wallets: undefined, balanceText: undefined }, 'zh-CN', { boxWidth: WIDE });
check('a payload without wallet rows still renders a balance', naive.text.includes('¥46.83'), naive.text);

console.log('locale');
const fromHook = render(ready, undefined, { boxWidth: WIDE });
check('the injected locale hook drives the copy', fromHook.text.includes('余额'), fromHook.text);
localeSnapshot.active = 'en-US';
const switched = render(ready, undefined, { boxWidth: WIDE });
check('a language change switches the copy live', switched.text.includes('Balance') && !switched.text.includes('余额'), switched.text);
localeSnapshot.active = 'zh-CN';
const switchedBack = render(ready, undefined, { boxWidth: WIDE });
check('switching back restores the Chinese copy', switchedBack.text.includes('余额'), switchedBack.text);
const noHook = render({ ...ready }, 'en-US', { useHooks: false, boxWidth: WIDE });
check('the prop stands in when no hook exists', noHook.text.includes('Balance'), noHook.text);
const noLocale = render({ ...ready }, undefined, { useHooks: false, boxWidth: WIDE });
check('the browser language is the last resort', noLocale.text.includes('余额'), noLocale.text);

console.log('today baseline');
const stored = JSON.parse(globalThis.window.localStorage.getItem('dsh-balance-usage-dock:day'));
globalThis.window.localStorage.setItem('dsh-balance-usage-dock:day', JSON.stringify({ day: stored.day, cost: 104.32995698 }));
const spent = render({ ...ready }, 'zh-CN', { boxWidth: WIDE });
check('a stored baseline produces a daily figure', spent.text.includes('¥4.50'), spent.text);
globalThis.window.localStorage.clear();

console.log('session identity');
const withSession = render(ready, 'zh-CN', { boxWidth: WIDE, sessionId: 'session-42' });
check('the injected session id reaches the component', withSession.parts === 'today+chart', withSession.parts);

console.log('no responses yet');
const empty = render({ ...ready, responses: [] }, 'en-US', { useHooks: false, boxWidth: WIDE });
check('an empty session draws no bars', !empty.types.includes('rect'), empty.types);
check('an empty session says so in the tooltip', empty.title.includes('No response usage'), empty.title);
check('an empty session still shows today', empty.parts === 'today', empty.parts);

console.log('status states');
check('signed-out copy', render({ status: 'signed-out', timezoneOffsetMinutes: 480 }, 'zh-CN').text.includes('登录 DeepSeek'));
check('loading copy', render({ status: 'loading' }, 'zh-CN').text.includes('正在读取余额'));
const unavailable = render({ status: 'unavailable', error: 'platform summary unavailable' }, 'zh-CN');
check('unavailable copy', unavailable.text.includes('暂时无法读取'), unavailable.text);
check('failure reason in the tooltip', unavailable.title.includes('platform summary unavailable'), unavailable.title);

console.log('formatting');
// Spend text comes from the Host; the dock renders it as given.
const spentSmall = render({ ...ready, spentText: '<¥0.01' }, 'zh-CN', { boxWidth: WIDE });
check('the Host sub-cent spend text is used as given', spentSmall.title.includes('<¥0.01'), spentSmall.title);
const grouped = render({
	...ready,
	symbol: '$',
	balance: 1234567.891,
	balanceText: undefined,
	wallets: [{ currency: 'USD', amount: 1234567.891, display: '$1,234,567.89' }],
}, 'en-US', { boxWidth: WIDE });
check('the Host display text is used verbatim', grouped.text.includes('$1,234,567.89'), grouped.text);
const selfFormatted = render({ ...ready, symbol: '$', balance: 1234567.891, balanceText: undefined, wallets: undefined }, 'en-US', { boxWidth: WIDE });
check('a payload without Host text groups digits itself', selfFormatted.text.includes('$1,234,567.89'), selfFormatted.text);

console.log('token labels');
const many = render({
	...ready,
	responses: [{ total: 1234, output: 999, input: 235 }, { total: 45678, output: 12345, input: 33333 }],
}, 'en-US', { useHooks: false, boxWidth: WIDE });
check('the newest response drives the headline', many.title.includes('Response 2: 46k tok'), many.title);
check('the tooltip stays scoped to the newest response', !many.title.includes('Response 1'), many.title);

globalThis.window.localStorage.clear();
console.log(failures.length === 0 ? '\nALL CHECKS PASSED' : `\n${failures.length} CHECK(S) FAILED: ${failures.join(', ')}`);
process.exit(failures.length === 0 ? 0 : 1);
