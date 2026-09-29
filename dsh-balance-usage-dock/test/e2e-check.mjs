/**
 * End-to-end check against a running DSH Web profile that has this bundle
 * selected: the served boot graph must carry one row whose id equals the
 * package name, the served bundle must register exactly that id, and the Host
 * state route must answer JSON.
 */
const base = process.argv[2] ?? 'http://127.0.0.1:3080';
const token = process.argv[3];
const packageName = process.argv[4];

const failures = [];
const check = (label, ok, detail) => {
	console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail === undefined || ok ? '' : ` — ${JSON.stringify(detail)}`}`);
	if (!ok) failures.push(label);
};

const exchange = await fetch(`${base}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' });
const cookie = (exchange.headers.getSetCookie?.() ?? []).map((entry) => entry.split(';')[0]).join('; ');
check('the launch token exchanges for a session cookie', exchange.status === 303 && cookie !== '', exchange.status);

const html = await (await fetch(`${base}/`, { headers: { cookie } })).text();
check('the index is served', html.length > 1000, html.length);
const graph = JSON.parse(/globalThis\["__DSH_BOOT__"\] = (\{.*?\})\u003c\/script>/s.exec(html.replace(/&amp;/g, '&'))[1]);

const rows = graph.entries.filter((entry) => entry.id === packageName);
check('exactly one boot graph row for the plugin', rows.length === 1, rows.length);
check('no duplicate row ids anywhere', new Set(graph.entries.map((entry) => entry.id)).size === graph.entries.length);
const row = rows[0];
if (row === undefined) {
	console.log('\nno plugin row; is the bundle selected in this profile?');
	process.exit(1);
}

const served = await (await fetch(`${base}/${row.url}`, { headers: { cookie } })).text();
check('the bundle is served', served.length > 1000, served.length);
const registered = /__ModuleLoader__[\s\S]{0,80}?id:\s*(["'])([^"']+)\1/.exec(served)?.[2];
check('the bundle registers the row id', registered === row.id, { registered, rowId: row.id });
check('the bundle holds one factory', [...served.matchAll(/__ModuleLoader__\.load\(/g)].length === 1);

const state = await fetch(`${base}/dsh-balance-usage/state`, { headers: { cookie, origin: base } });
check('the state route answers', state.status === 200, state.status);
const body = await state.json().catch(() => undefined);
check('the state route answers JSON', body !== undefined && typeof body.status === 'string', body);
check('the state carries the token series', Array.isArray(body?.responses), body?.responses);
if (body?.status === 'ready') {
	check('a ready state lists wallet rows', Array.isArray(body.wallets) && body.wallets.length > 0, body.wallets);
	check('every wallet row carries display text', body.wallets.every((wallet) => typeof wallet.display === 'string'), body.wallets);
	check('the headline is text', typeof body.balanceText === 'string', body.balanceText);
}

const withSession = await fetch(`${base}/dsh-balance-usage/state?session=session-unknown`, { headers: { cookie, origin: base } });
check('a session query is accepted', withSession.status === 200, withSession.status);
const sessionBody = await withSession.json().catch(() => undefined);
check('an unknown session still answers a series', Array.isArray(sessionBody?.responses), sessionBody?.responses);

const foreign = await fetch(`${base}/dsh-balance-usage/state`, { headers: { origin: 'https://evil.example' } });
check('a foreign origin is refused', foreign.status === 403, foreign.status);

// The history view reads session projections; a unit without a stateSchema made
// that call answer `gateway/internal ... reading 'parse'`.
const projectionCall = await fetch(`${base}/api/session/projections`, {
	method: 'POST',
	headers: { 'content-type': 'application/json', cookie },
	body: JSON.stringify({
		type: 'client-request',
		rpcId: `e2e-${Math.random().toString(36).slice(2)}`,
		method: 'session/projections',
		payload: { args: { request: { sessionId: 'session-unknown' } } },
	}),
});
const projectionText = await projectionCall.text();
check('the projection read is answered', projectionCall.status === 200, projectionCall.status);
check('the projection read is not a gateway fault', !projectionText.includes('gateway/internal'), projectionText.slice(0, 300));
check('the projection read carries no parse failure', !projectionText.includes("reading 'parse'"), projectionText.slice(0, 300));

console.log(failures.length === 0 ? '\nEND TO END OK' : `\n${failures.length} FAILED: ${failures.join(', ')}`);
process.exit(failures.length === 0 ? 0 : 1);
