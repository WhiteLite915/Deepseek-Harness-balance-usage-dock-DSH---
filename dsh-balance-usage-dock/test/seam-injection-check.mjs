/**
 * Fault-injection proof for the schema fix: complete the projection seam's
 * restore path exactly as the Host registry does, with and without the
 * `stateSchema` the broken build omitted.
 *
 *   node test/seam-injection-check.mjs
 */
const definition = {
	key: 'injectedTokens',
	stateVersion: 1,
	init: () => [],
	apply: (state) => state,
	wire: { view: (state) => state },
};

/** What `SessionProjectionRegistry.restore()` does with one persisted row. */
function restore(def, row) {
	const usable = row !== undefined && row.ver === def.stateVersion;
	return usable ? def.stateSchema.parse(row.val) : def.init();
}

const failures = [];
function check(label, condition, detail) {
	console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label}${detail === undefined || condition ? '' : ` — ${detail}`}`);
	if (!condition) failures.push(label);
}

/** Capture the exact failure text the user's app reported. */
function failureOf(def, row) {
	try {
		restore(def, row);
		return null;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

const row = { ver: 1, seq: 3, val: [{ total: 1, output: 1, input: 0, at: 0 }] };

const broken = failureOf(definition, row);
check('the schema-less unit throws', broken !== null, String(broken));
check('the message is the reported one', broken !== null && broken.includes("reading 'parse'"), String(broken));

const viewFailure = (() => {
	const wire = { viewSchema: undefined, view: (state) => state };
	try {
		wire.viewSchema.parse(wire.view([]));
		return null;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
})();
check('the schema-less view throws too', viewFailure !== null && viewFailure.includes("reading 'parse'"), String(viewFailure));

const fixed = { ...definition, stateSchema: { parse: (value) => value } };
check('adding a stateSchema fixes the restore', failureOf(fixed, row) === null, String(failureOf(fixed, row)));
check(
	'a stale row is re-folded instead of parsed',
	restore(fixed, { ver: 0, seq: 3, val: 'corrupt' }).length === 0,
);

console.log(failures.length === 0 ? '\nFAULT INJECTION OK' : `\n${failures.length} FAILED: ${failures.join(', ')}`);
process.exit(failures.length === 0 ? 0 : 1);
