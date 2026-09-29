/**
 * Regression check for the Session projection seam contract.
 *
 * The seam validates both faces of a unit with `.parse()`: a restored
 * checkpoint row goes through `stateSchema.parse`, and every client view goes
 * through `wire.viewSchema.parse`. A unit that omits either one throws
 * "Cannot read properties of undefined (reading 'parse')" and fails the whole
 * session load, which is exactly the reported history-loading bug. This file
 * drives the real definition through those calls.
 */
import { foldTokenSeries, tokenSeriesProjection } from '../index.js';

const failures = [];
function check(label, condition, detail) {
	console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label}${detail === undefined || condition ? '' : ` — ${JSON.stringify(detail)}`}`);
	if (!condition) failures.push(label);
}

console.log('unit shape');
check('declares a key', typeof tokenSeriesProjection.key === 'string' && tokenSeriesProjection.key !== '', tokenSeriesProjection.key);
check('declares an integer stateVersion', Number.isSafeInteger(tokenSeriesProjection.stateVersion), tokenSeriesProjection.stateVersion);
check('declares init()', typeof tokenSeriesProjection.init === 'function');
check('declares apply()', typeof tokenSeriesProjection.apply === 'function');
check('declares a stateSchema.parse()', typeof tokenSeriesProjection.stateSchema?.parse === 'function', Object.keys(tokenSeriesProjection));
check('declares wire.view()', typeof tokenSeriesProjection.wire?.view === 'function');
check('declares a wire.viewSchema.parse()', typeof tokenSeriesProjection.wire?.viewSchema?.parse === 'function', Object.keys(tokenSeriesProjection.wire ?? {}));

// What the seam does: fold the durable log, checkpoint the state, then restore
// the row on the next cold read.
console.log('fold, checkpoint, restore');
let state = tokenSeriesProjection.init();
for (const event of [
	{ type: 'turn/start', time: 100, data: { turn: 0 } },
	{ type: 'assistant/message', time: 110, data: { turn: 0, step: 0, usage: { inputTokens: 10, outputTokens: 5 } } },
	{ type: 'tool/call', time: 120, data: { turn: 0, step: 0, callId: 'a' } },
	{ type: 'assistant/message', time: 130, data: { turn: 0, step: 1, usage: { inputTokens: 20, outputTokens: 700 } } },
	{ type: 'turn/start', time: 200, data: { turn: 1 } },
	{ type: 'assistant/message', time: 210, data: { turn: 1, step: 0, usage: { inputTokens: 1, outputTokens: 2 } } },
]) state = tokenSeriesProjection.apply(state, event);
check('one sample per complete reply (turn)', state.length === 2, state);
check('steps within a turn are summed', state[0].total === 735 && state[0].output === 705 && state[0].input === 30, state[0]);
check('each sample keeps its turn', state[0].turn === 0 && state[1].turn === 1, state);

const row = { key: tokenSeriesProjection.key, ver: tokenSeriesProjection.stateVersion, seq: 5, val: JSON.parse(JSON.stringify(state)) };
const restored = tokenSeriesProjection.stateSchema.parse(row.val);
check('the checkpoint row restores', restored.length === 2, restored);
check('restored samples keep their fields', restored[1].total === 3 && restored[1].turn === 1, restored[1]);

const continued = foldTokenSeries(restored, { type: 'assistant/message', time: 220, data: { turn: 1, step: 1, usage: { inputTokens: 3, outputTokens: 4 } } });
check('a later step in the open turn still merges', continued.length === 2 && continued[1].total === 10 && continued[1].output === 6, continued[1]);
check('a message without a turn is its own sample', foldTokenSeries([], { type: 'assistant/message', time: 300, data: { usage: { inputTokens: 5, outputTokens: 5 } } }).length === 1);

// What the seam does for every client read: view, then validate the view.
console.log('client view');
const view = tokenSeriesProjection.wire.view(continued);
check('the view validates', tokenSeriesProjection.wire.viewSchema.parse(view).length === 2, view);
check('the view is a fresh array', tokenSeriesProjection.wire.view(continued) !== tokenSeriesProjection.wire.view(continued));
check(
	'the view is capped at the documented length',
	tokenSeriesProjection.wire.view(new Array(500).fill({ total: 1, output: 1, input: 0, at: 0 })).length === 40,
	tokenSeriesProjection.wire.view(new Array(500).fill({ total: 1, output: 1, input: 0, at: 0 })).length,
);

// A stored row that fails the schema must be rejected, never accepted silently.
console.log('corrupt rows');
for (const [label, value] of [
	['an object instead of a list', { samples: [] }],
	['a missing field', [{ total: 1, output: 1, input: 1 }]],
	['a non-numeric field', [{ total: '1', output: 0, input: 0, at: 0 }]],
	['a negative field', [{ total: 0, output: -5, input: 0, at: 0 }]],
	['a non-numeric turn', [{ total: 1, output: 0, input: 0, at: 0, turn: '1' }]],
	['a negative turn', [{ total: 1, output: 0, input: 0, at: 0, turn: -1 }]],
	['a null sample', [null]],
]) {
	let threw = false;
	try {
		tokenSeriesProjection.stateSchema.parse(value);
	} catch {
		threw = true;
	}
	check(`rejects ${label}`, threw);
}

console.log(failures.length === 0 ? '\nPROJECTION SEAM OK' : `\n${failures.length} FAILED: ${failures.join(', ')}`);
process.exit(failures.length === 0 ? 0 : 1);
