/**
 * Local harness for the Host half: drives the poller with a fake credential
 * service, a synthetic Platform summary and a virtual clock, then checks the
 * JSON snapshots the Client receives.
 */
import { apply, foldTokenSeries, readTokenSeries, summarize, tokenSeriesProjection, tokenTotal } from '../index.js';

const origin = 'https://platform.deepseek.com';
const grant = { version: 1, token: 'test-token', issuer: origin };

let counter = 100.0;
/** The topped-up wallet as exact decimal text, so the fixture never drifts. */
let balance = '42.5000000000000000';
let callCount = 0;
const baseTime = Date.parse('2026-01-01T03:00:00.000Z');
let virtualNow = baseTime;

/**
 * A stand-in session projection registry: it folds the plugin's own unit over
 * whatever events a test appends, which is precisely what the Host seam does.
 */
function createProjectionStub() {
	const cells = new Map();
	return {
		registered: [],
		register(definition) {
			this.registered.push(definition.key);
			return () => {};
		},
		stateOf(session, key) {
			if (key !== tokenSeriesProjection.key) return undefined;
			let state = cells.get(session);
			if (state === undefined) {
				state = tokenSeriesProjection.init();
				for (const event of events) state = tokenSeriesProjection.apply(state, event);
				cells.set(session, state);
			}
			return state;
		},
		reset() {
			cells.clear();
		},
	};
}

const sessionsStub = {
	live: [{ id: 'session-a', seq: 3 }, { id: 'session-b', seq: 1 }],
	get(id) {
		return this.live.find((session) => session.id === id);
	},
	list() {
		return this.live;
	},
};

let events = [];
const projections = createProjectionStub();

/** Summary body shaped like the real Platform response. */
function summaryBody() {
	return {
		code: 0,
		msg: '',
		data: {
			biz_code: 0,
			biz_msg: '',
			biz_data: {
				// Exact decimal text, never a float: the plugin truncates this text,
				// so the fixture must be as precise as the Platform's own answer.
				normal_wallets: [{ currency: 'CNY', balance: `${balance}`, token_estimation: '0' }],
				bonus_wallets: [{ currency: 'CNY', balance: '4.3334291200000000', token_estimation: '0' }],
				total_costs: [{ currency: 'CNY', amount: counter.toFixed(16) }],
			},
		},
	};
}

globalThis.fetch = async (url, init) => {
	callCount++;
	if (String(url) !== `${origin}/api/v0/users/get_user_summary`) throw new Error(`unexpected url ${url}`);
	if (init?.headers?.['x-dsh-auth-token'] !== grant.token) throw new Error('missing grant header');
	return {
		ok: true,
		status: 200,
		async json() {
			return summaryBody();
		},
		body: { cancel() {} },
	};
};

const credentials = {
	async readRecord(key) {
		if (key !== 'deepseek-account-platform/default') throw new Error(`unexpected key ${key}`);
		return { kind: 'grant', payload: grant };
	},
};

let route;
const ctx = {
	get(name) {
		if (name === 'credentials') return credentials;
		if (name === 'webServer') {
			return {
				register(entry) {
					route = entry;
					return () => {
						route = undefined;
					};
				},
			};
		}
		if (name === 'sessions') return sessionsStub;
		if (name === 'sessionProjections') return projections;
		return undefined;
	},
};

const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;
const realNow = Date.now;
let tick;
globalThis.setInterval = (fn) => {
	tick = fn;
	return { unref() {} };
};
globalThis.clearInterval = () => {
	tick = undefined;
};
Date.now = () => virtualNow;

/** Read the snapshot the way the browser would. */
function readState(headers = { origin: 'http://127.0.0.1:19387' }, method = 'GET') {
	let status;
	let responseHeaders;
	let body;
	route.handler(
		{ method, headers },
		{
			writeHead(code, given) {
				status = code;
				responseHeaders = given;
			},
			end(payload) {
				body = payload === undefined ? undefined : JSON.parse(payload.toString('utf8'));
			},
		},
	);
	return { status, headers: responseHeaders, body };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));
const failures = [];
function check(label, condition, detail) {
	if (condition) {
		console.log(`  ok   ${label}`);
		return;
	}
	failures.push(label);
	console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
}

console.log('per-response token fold');
check('a usage record totals every billed bucket', JSON.stringify(tokenTotal({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 5, cacheWriteTokens: 1 })) === JSON.stringify({ total: 126, output: 20, input: 106 }), tokenTotal({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 5, cacheWriteTokens: 1 }));
check('an empty usage record is ignored', tokenTotal({ inputTokens: 0, outputTokens: 0 }) === undefined, tokenTotal({ inputTokens: 0, outputTokens: 0 }));
check('a non-record is ignored', tokenTotal(undefined) === undefined && tokenTotal('x') === undefined);
const foldStart = tokenSeriesProjection.init();
check('the unit starts empty', Array.isArray(foldStart) && foldStart.length === 0, foldStart);
check('an unrelated event keeps the state reference', foldTokenSeries(foldStart, { type: 'tool/call', data: {} }) === foldStart);
check('an unmeasured response keeps the state reference', foldTokenSeries(foldStart, { type: 'assistant/message', data: {} }) === foldStart);
const folded = foldTokenSeries(foldStart, { type: 'assistant/message', time: 1234, data: { usage: { inputTokens: 100, outputTokens: 20 } } });
check('a measured response appends one sample', folded.length === 1, folded);
check('the sample keeps its split', folded[0].total === 120 && folded[0].output === 20 && folded[0].input === 100, folded[0]);
check('the sample keeps the event time', folded[0].at === 1234, folded[0]);
check('the fold does not mutate the previous state', foldStart.length === 0, foldStart);

// The seam validates both faces with `.parse()`: a unit without them fails every
// session load that restores a checkpoint, which is the reported history bug.
console.log('projection validation contract');
check('the state schema exists', typeof tokenSeriesProjection.stateSchema?.parse === 'function', Object.keys(tokenSeriesProjection));
check('the view schema exists', typeof tokenSeriesProjection.wire?.viewSchema?.parse === 'function', Object.keys(tokenSeriesProjection.wire ?? {}));
check('the state version was bumped past the schema-less unit', tokenSeriesProjection.stateVersion === 3, tokenSeriesProjection.stateVersion);
check('an empty state validates', tokenSeriesProjection.stateSchema.parse([]).length === 0);
check('a folded state validates', tokenSeriesProjection.stateSchema.parse(folded).length === 1);
const view = tokenSeriesProjection.wire.view(folded);
check('the view validates', tokenSeriesProjection.wire.viewSchema.parse(view).length === 1);
check('the view is a fresh array each read', tokenSeriesProjection.wire.view(folded) !== tokenSeriesProjection.wire.view(folded));
const rejects = (value) => {
	try {
		tokenSeriesProjection.stateSchema.parse(value);
		return false;
	} catch {
		return true;
	}
};
check('a non-array state is rejected', rejects({ total: 1 }));
check('a missing field is rejected', rejects([{ total: 1, output: 1, input: 1 }]));
check('a negative count is rejected', rejects([{ total: -1, output: 0, input: 0, at: 0 }]));
check('a string count is rejected', rejects([{ total: '1', output: 0, input: 0, at: 0 }]));

console.log('token series read');
events = [
	{ type: 'assistant/message', time: 10, data: { usage: { inputTokens: 10, outputTokens: 1 } } },
	{ type: 'step/end', data: {} },
	{ type: 'assistant/message', time: 20, data: { usage: { inputTokens: 20, outputTokens: 2 } } },
];
projections.reset();
const read = readTokenSeries({ get: (name) => (name === 'sessions' ? sessionsStub : name === 'sessionProjections' ? projections : undefined) }, 'session-a');
check('the newest samples are returned', read.samples.length === 2, read.samples);
check('the requested session answers', read.session === 'session-a', read.session);
projections.reset();
const unknown = readTokenSeries({ get: (name) => (name === 'sessions' ? sessionsStub : name === 'sessionProjections' ? projections : undefined) }, 'session-missing');
check('an unknown session falls back to the newest live one', unknown.session === 'session-b', unknown.session);
check('a registry-free composition reads safely', readTokenSeries({ get: () => undefined }, 'session-a').samples.length === 0);

console.log('summarize()');
const projected = summarize(summaryBody());
check('wallet total adds both wallet kinds', Math.abs(projected.balance - (42.5 + 4.33342912)) < 1e-9, projected);
check('cost counter is read', projected.cost === 100, projected);
check('currency is picked', projected.currency === 'CNY', projected);
check('both wallets are listed', projected.wallets.length === 2, projected.wallets);
check('every wallet keeps its exact decimal text', projected.wallets.every((wallet) => typeof wallet.exact === 'string'), projected.wallets);
check('empty payload is rejected', summarize({ data: { biz_data: {} } }) === undefined);

console.log('balance display (Platform Web truncates each wallet to cents)');
// The user's case: the account page shows ¥22.83 + ¥1.76 = ¥24.59, while a
// rounding conversion showed ¥22.84 + ¥1.77 = ¥24.61. Truncation from the exact
// decimal text keeps the cent the wallet already holds, third digit or not.
const tieCase = summarize({
	data: {
		biz_data: {
			normal_wallets: [{ currency: 'CNY', balance: '22.8350000000000000' }],
			bonus_wallets: [{ currency: 'CNY', balance: '1.7650000000000000' }],
			total_costs: [{ currency: 'CNY', amount: '11.0000000000000000' }],
		},
	},
});
check('a third decimal of five never rounds a wallet up', tieCase !== undefined, tieCase);

const dispose = apply(ctx, { pollIntervalMs: 5000, platformOrigin: origin });
await settle();

console.log('route');
const first = readState();
check('route answered 200', first.status === 200, first);
check('json content type', String(first.headers['content-type']).startsWith('application/json'), first.headers);
check('no-store', first.headers['cache-control'] === 'no-store', first.headers);
check('loopback origin echoed', first.headers['access-control-allow-origin'] === 'http://127.0.0.1:19387', first.headers);
check('first snapshot is ready', first.body.status === 'ready', first.body);
check('the snapshot carries the token series', Array.isArray(first.body.responses), first.body.responses);
check('the token series names its session', first.body.tokenSession === 'session-b', first.body.tokenSession);
check('the projection unit was registered', projections.registered.includes('balanceUsageDockTokens'), projections.registered);

// 42.50 + 4.33342912 = 46.83342912: the headline is the sum of the two
// displayed rows, not a conversion of the combined number.
check('displayed balance is the sum of the wallet rows', first.body.balanceText === '¥46.83', first.body.balanceText);
check('wallet rows carry their own display text', first.body.wallets.map((row) => row.display).join(' + ') === '¥42.50 + ¥4.33', first.body.wallets);
check('every row keeps the exact decimal text', first.body.wallets.every((row) => typeof row.exact === 'string'), first.body.wallets);
check('the split flag is set for two positive wallets', first.body.isSplit === true, first.body.isSplit);
check('the exact total stays available', Math.abs(first.body.balance - 46.83342912) < 1e-9, first.body.balance);

console.log('polling');
for (let round = 0; round < 10; round++) {
	virtualNow += 30000;
	counter += 0.01;
	// Exact text again: 42.50 - 0.10 = 42.40, not a float that truncates to .39.
	balance = (42.5 - (round + 1) * 0.01).toFixed(10);
	tick?.();
	await settle();
}
const later = readState();
check('counter grew', later.body.cost > first.body.cost, { first: first.body.cost, later: later.body.cost });
check('session spend accumulates', later.body.spentSinceStart > 0, later.body.spentSinceStart);
check('the session spend is formatted', later.body.spentText === '¥0.10', later.body.spentText);
check('balance text follows the wallet', later.body.balanceText === '¥46.73', later.body);

console.log('guards');
check('cross-origin read refused', readState({ origin: 'https://evil.example' }).status === 403);
check('non-GET refused', readState({}, 'POST').status === 405);
check('no origin header allowed', readState({}).status === 200);

console.log('account change');
counter = 5;
virtualNow += 30000;
balance = '42.4000000000000000';
tick?.();
await settle();
const reset = readState();
check('a backwards counter restarts the session spend', reset.body.spentSinceStart === 0 || reset.body.spentSinceStart === undefined, reset.body.spentSinceStart);
check('the balance follows the new wallet', reset.body.balanceText === '¥46.73', reset.body.balanceText);

dispose();

console.log('third-decimal tie (the reported ¥0.02 case)');
// 22.835 and 1.765 both carry a five in the third decimal: rounding gives
// 22.84 + 1.77 = 24.61, truncating gives 22.83 + 1.76 = 24.59.
const tieCtx = {
	get(name) {
		if (name === 'credentials') {
			return {
				async readRecord() {
					return {
						kind: 'grant',
						payload: { version: 1, token: 'test-token', issuer: origin },
					};
				},
			};
		}
		if (name === 'webServer') {
			return {
				register(entry) {
					route = entry;
					return () => {};
				},
			};
		}
		return undefined;
	},
};
globalThis.fetch = async () => ({
	ok: true,
	status: 200,
	async json() {
		return {
			data: {
				biz_data: {
					normal_wallets: [{ currency: 'CNY', balance: '22.8350000000000000' }],
					bonus_wallets: [{ currency: 'CNY', balance: '1.7650000000000000' }],
					total_costs: [{ currency: 'CNY', amount: '11.0000000000000000' }],
				},
			},
		};
	},
	body: { cancel() {} },
});
const disposeTie = apply(tieCtx, { pollIntervalMs: 5000, platformOrigin: origin });
await settle();
const tie = readState();
check('the headline is the account page total', tie.body.balanceText === '¥24.59', tie.body.balanceText);
check('no wallet is rounded up', tie.body.wallets.map((row) => row.display).join(' + ') === '¥22.83 + ¥1.76', tie.body.wallets);
check('the reported ¥24.61 never appears', tie.body.balanceText !== '¥24.61', tie.body.balanceText);
disposeTie();
globalThis.fetch = async (url, init) => {
	callCount++;
	if (String(url) !== `${origin}/api/v0/users/get_user_summary`) throw new Error(`unexpected url ${url}`);
	if (init?.headers?.['x-dsh-auth-token'] !== grant.token) throw new Error('missing grant header');
	return {
		ok: true,
		status: 200,
		async json() {
			return summaryBody();
		},
		body: { cancel() {} },
	};
};

console.log('signed out');
const signedOutCtx = {
	get(name) {
		if (name === 'credentials') return { async readRecord() { return undefined; } };
		if (name === 'webServer') {
			return {
				register(entry) {
					route = entry;
					return () => {};
				},
			};
		}
		return undefined;
	},
};
const disposeSecond = apply(signedOutCtx, {});
await settle();
const signedOut = readState();
check('signed-out state is reported', signedOut.body.status === 'signed-out', signedOut.body);
check('signed out still carries the token series', Array.isArray(signedOut.body.responses), signedOut.body.responses);
disposeSecond();

Date.now = realNow;
globalThis.setInterval = realSetInterval;
globalThis.clearInterval = realClearInterval;
console.log(`\nfetch calls: ${callCount}`);
console.log(failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED: ${failures.join(', ')}`);
process.exit(failures.length === 0 ? 0 : 1);
