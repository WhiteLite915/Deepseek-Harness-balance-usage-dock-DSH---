/**
 * Exercise the Host path that failed before the schema fix: the session
 * projection read the Web history view uses. A unit without a `stateSchema`
 * makes this call answer `gateway/internal ... reading 'parse'`, which is the
 * reported history-loading failure.
 *
 *   node test/session-read-check.mjs <base> <token> [sessionId]
 */
const base = process.argv[2] ?? 'http://127.0.0.1:3080';
const token = process.argv[3];
const sessionId = process.argv[4] ?? 'session-unknown';

const failures = [];
const check = (label, ok, detail) => {
	console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail === undefined || ok ? '' : ` — ${JSON.stringify(detail).slice(0, 400)}`}`);
	if (!ok) failures.push(label);
};

const exchange = await fetch(`${base}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' });
const cookie = (exchange.headers.getSetCookie?.() ?? []).map((entry) => entry.split(';')[0]).join('; ');
check('the launch token exchanges for a session cookie', exchange.status === 303 && cookie !== '', exchange.status);

/** One Client Remote call, framed exactly as the browser frames it. */
async function rpc(endpoint, args) {
	const response = await fetch(`${base}/api/${endpoint}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', cookie },
		body: JSON.stringify({ type: 'client-request', rpcId: `check-${Math.random().toString(36).slice(2)}`, method: endpoint, payload: { args } }),
	});
	return { status: response.status, text: await response.text() };
}

// The descriptor names the session parameter `request`.
const read = await rpc('session/projections', { request: { sessionId } });
check('the projection read is answered', read.status === 200, read.status);
check('the projection read is not a gateway fault', !read.text.includes('gateway/internal'), read.text.slice(0, 300));
check('the projection read carries no parse failure', !read.text.includes("reading 'parse'"), read.text.slice(0, 300));
const envelope = JSON.parse(read.text);
check('the answer is a Remote envelope', envelope?.type === 'server-response', envelope);
const body = envelope?.result;
check('the Remote result is an envelope', typeof body?.ok === 'boolean', body);
if (body?.ok === true) {
	check('the projection read returned a snapshot or null', body.value === null || typeof body.value === 'object', body.value);
	const values = body.value?.values;
	console.log('  projections:', values === undefined ? '(none)' : JSON.stringify(Object.keys(values)));
	check('the plugin unit is not part of the client-visible set', values?.balanceUsageDockTokens === undefined, values?.balanceUsageDockTokens);
} else {
	console.log('  remote error:', JSON.stringify(body?.error));
}

console.log(failures.length === 0 ? '\nSESSION READ OK' : `\n${failures.length} FAILED: ${failures.join(', ')}`);
process.exit(failures.length === 0 ? 0 : 1);
