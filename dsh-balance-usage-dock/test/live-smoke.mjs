/**
 * Live smoke test: reads the real stored account grant and prints what the
 * Host half would project, with the exact and displayed wallet amounts side by
 * side so the dock's headline can be compared with the account page.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { summarize } from '../index.js';

const credentialsFile = path.join(os.homedir(), '.dsh', '.credentials.yaml');
const raw = fs.readFileSync(credentialsFile, 'utf8');
const token = /^\s+token:\s*(\S+)\s*$/m.exec(raw)?.[1];
if (token === undefined) {
	console.log('no stored account grant; skipping the live read');
	process.exit(0);
}

const response = await fetch('https://platform.deepseek.com/api/v0/users/get_user_summary', {
	method: 'GET',
	headers: { 'x-dsh-auth-token': token, accept: 'application/json' },
	signal: AbortSignal.timeout(10000),
});
console.log('HTTP', response.status);
const body = await response.json();
const normal = body?.data?.biz_data?.normal_wallets ?? [];
const bonus = body?.data?.biz_data?.bonus_wallets ?? [];
for (const wallet of normal) console.log('normal wallet', wallet.currency, wallet.balance);
for (const wallet of bonus) console.log('bonus wallet ', wallet.currency, wallet.balance);
for (const cost of body?.data?.biz_data?.total_costs ?? []) console.log('lifetime cost', cost.currency, cost.amount);

/** Truncate exact decimal text to two fraction digits, as the dock does. */
function displayed(text) {
	const [whole, fraction = ''] = String(text).split('.');
	return `${whole}.${`${fraction}00`.slice(0, 2)}`;
}

const rows = [...normal, ...bonus].map((wallet) => displayed(wallet.balance));
const projected = summarize(body);
console.log('');
console.log('exact total     ', projected?.balance?.toFixed(8));
console.log('account rows    ', rows.join(' + '), '=', rows.reduce((total, value) => total + Number(value), 0).toFixed(2));
console.log('projected       ', JSON.stringify(projected));
