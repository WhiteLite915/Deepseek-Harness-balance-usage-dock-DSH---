/**
 * Host half of the Balance & Usage Dock plugin.
 *
 * It polls the configured DeepSeek Platform account summary with the login
 * grant the Harness already stores, folds the session's own per-response token
 * usage through the Session projection seam, and serves one read-only JSON
 * snapshot on `GET /dsh-balance-usage/state` through the Web server.
 *
 * The browser half renders that snapshot in `conversation.composer.dock`.
 * No credential ever leaves the Host process.
 */

/** Platform account endpoint holding wallets and the lifetime cost counter. */
const SUMMARY_PATH = "/api/v0/users/get_user_summary";
/** Route claimed by this plugin for the Client snapshot read. */
const ROUTE_PATH = "/dsh-balance-usage";
/** Loopback hostnames a browser document may be served from. */
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
/** Extra origins allowed to read the snapshot (the embedded Platform view). */
const EXTRA_ALLOWED_ORIGINS = new Set(["https://platform.deepseek.com"]);
/** Longest window the snapshot needs, plus headroom for the day baseline. */
const KEEP_MS = 75 * 60 * 1000;
/** Per-response token samples kept per session; the chart draws the newest ones. */
const TOKEN_SERIES_LIMIT = 200;
/** Responses the snapshot hands to the chart. */
const TOKEN_SERIES_VIEW = 40;

/** Whether a browser document's origin may read the snapshot. */
function isAllowedOrigin(origin) {
	if (EXTRA_ALLOWED_ORIGINS.has(origin)) return true;
	try {
		const url = new URL(origin);
		return (url.protocol === "http:" || url.protocol === "https:") && LOOPBACK_HOSTNAMES.has(url.hostname);
	} catch {
		return false;
	}
}

/** Clamp one numeric option into an integer range. */
function boundedInteger(value, fallback, min, max) {
	const parsed = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(parsed)) return fallback;
	return Math.min(max, Math.max(min, Math.round(parsed)));
}

/** Admit only a bare HTTP(S) origin without credentials, path, query or hash. */
function normalizeOrigin(value) {
	if (typeof value !== "string") return undefined;
	try {
		const url = new URL(value);
		if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
		if (url.username !== "" || url.password !== "" || url.pathname !== "/" || url.search !== "" || url.hash !== "") return undefined;
		return url.origin;
	} catch {
		return undefined;
	}
}

/** Normalize the optional per-plugin config; the shipped defaults need no row. */
export function normalizeConfig(input) {
	const source = input !== null && typeof input === "object" ? input : {};
	return {
		enabled: source.enabled !== false,
		pollIntervalMs: boundedInteger(source.pollIntervalMs, 15000, 5000, 60000),
		platformOrigin: normalizeOrigin(source.platformOrigin) ?? "https://platform.deepseek.com",
		credentialKey: typeof source.credentialKey === "string" && /^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/.test(source.credentialKey)
			? source.credentialKey
			: "deepseek-account-platform/default",
		requestTimeoutMs: boundedInteger(source.requestTimeoutMs, 10000, 2000, 60000),
	};
}

/** Exact decimal text, the only form a Platform amount is ever truncated from. */
const DECIMAL_TEXT = /^-?(?:\d+(?:\.\d*)?|\.\d+)$/;

/** Parse an exact decimal string into a number, or null when it is not one. */
function decimal(value) {
	if (typeof value !== "string" || !DECIMAL_TEXT.test(value)) return null;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Truncate a computed float to two decimals (spend deltas, not wallet text).
 * @param amount - computed amount.
 * @returns the amount with any fraction below a cent removed.
 */
function truncateToCents(amount) {
	if (!Number.isFinite(amount)) return amount;
	if (amount < 0) return -truncateToCents(-amount);
	// Rounding at seven decimals first absorbs float noise, so a value that only
	// looks like 22.834999999 is still truncated to 22.83 rather than 22.84.
	return Math.floor(Number((amount + Number.EPSILON).toFixed(7)) * 100) / 100;
}

/** Sum the wallet rows of one Platform summary section. */
function walletTotal(rows) {
	let total = 0;
	let found = false;
	const wallets = [];
	if (!Array.isArray(rows)) return { total: 0, wallets };
	for (const row of rows) {
		if (row === null || typeof row !== "object") continue;
		// Keep the exact decimal text: the displayed amount must be truncated
		// from what Platform sent, never reconstructed from a rounded float.
		const exact = typeof row.balance === "string" && DECIMAL_TEXT.test(row.balance.trim()) ? row.balance.trim() : undefined;
		const amount = decimal(row.balance);
		if (amount === null) continue;
		found = true;
		total += amount;
		wallets.push({ currency: typeof row.currency === "string" ? row.currency : "", amount, exact });
	}
	return { total: found ? total : 0, wallets };
}

/** Read the lifetime cost counter of one currency from a summary. */
function costCounter(rows, currency) {
	if (!Array.isArray(rows)) return undefined;
	for (const row of rows) {
		if (row === null || typeof row !== "object") continue;
		if (currency !== "" && row.currency !== currency) continue;
		const amount = decimal(row.amount);
		if (amount !== null) return amount;
	}
	return undefined;
}

/**
 * Truncate exact decimal text to two fraction digits, the way Platform Web
 * shows a wallet. Positive amounts round DOWN, so a value whose third decimal
 * is five or more still shows the cent it already holds (22.8366 -> 22.83,
 * 22.835 -> 22.83, 22.839 -> 22.83).
 * @param value - validated decimal string.
 * @returns the truncated decimal text with exactly two fraction digits.
 */
function truncateDecimalText(value) {
	const negative = value.startsWith("-");
	const body = negative ? value.slice(1) : value;
	// `e`-notation carries no decimal text to truncate; fall back to the number.
	if (/[eE]/.test(body)) return truncateToCents(Number(body)).toFixed(2);
	const point = body.indexOf(".");
	const whole = point === -1 ? body : body.slice(0, point);
	const fraction = point === -1 ? "" : body.slice(point + 1);
	const kept = `${fraction}00`.slice(0, 2);
	return `${negative && !/^0*$/.test(`${whole}${kept}`) ? "-" : ""}${whole}.${kept}`;
}

/** Insert digit grouping into the integer part of decimal text. */
function groupDigits(text) {
	const point = text.indexOf(".");
	const whole = point === -1 ? text : text.slice(0, point);
	return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${point === -1 ? "" : text.slice(point)}`;
}

/**
 * The balance rows the dock shows, in the order Platform Web lists them.
 *
 * Platform Web renders the topped-up wallet and the granted credit as separate
 * amounts truncated to cents, so each row truncates its own exact text and the
 * dock's total is the plain sum of those two displayed rows.
 * @param wallets - normal wallets first, then bonus wallets.
 * @param symbol - currency symbol for display strings.
 * @returns display rows carrying exact, numeric and display forms.
 */
function balanceRows(wallets, symbol) {
	return wallets.map((wallet) => {
		const text = wallet.exact === undefined ? truncateToCents(wallet.amount).toFixed(2) : truncateDecimalText(wallet.exact);
		return {
			currency: wallet.currency,
			amount: wallet.amount,
			exact: wallet.exact,
			shown: Number(text),
			display: `${Number(text) < 0 ? "-" : ""}${symbol}${groupDigits(text.replace(/^-/, ""))}`,
		};
	});
}

/** Render a money amount with two decimals and digit grouping. */
function formatMoney(amount, symbol) {
	const fixed = amount.toFixed(2);
	const negative = fixed.startsWith("-");
	return `${negative ? "-" : ""}${symbol}${groupDigits(negative ? fixed.slice(1) : fixed)}`;
}

/** Render a spend amount: sub-cent values stay visible instead of reading as zero. */
function formatSpend(amount, symbol) {
	if (amount > 0 && amount < 0.005) return `<${symbol}0.01`;
	return formatMoney(truncateToCents(amount), symbol);
}

/**
 * Project one Platform summary payload into the fields the dock shows.
 * @param body - parsed `/api/v0/users/get_user_summary` response.
 * @returns wallet rows, the summed balance, its currency and the cost counter.
 */
export function summarize(body) {
	const data = body?.data?.biz_data;
	if (data === null || typeof data !== "object") return undefined;
	const normal = walletTotal(data.normal_wallets);
	const bonus = walletTotal(data.bonus_wallets);
	if (normal.wallets.length === 0 && bonus.wallets.length === 0) return undefined;
	const currency = normal.wallets[0]?.currency ?? bonus.wallets[0]?.currency ?? "";
	return {
		currency,
		balance: normal.total + bonus.total,
		wallets: [...normal.wallets, ...bonus.wallets],
		cost: costCounter(data.total_costs, currency),
	};
}

/**
 * Exact token total of one provider usage record.
 *
 * The chart exists to compare responses, so the bar carries everything the
 * attempt billed: uncached input, cache traffic and output.
 * @param usage - `assistant/message` usage record.
 * @returns the total and its breakdown, or undefined when unusable.
 */
export function tokenTotal(usage) {
	if (usage === null || typeof usage !== "object") return undefined;
	const count = (value) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : 0);
	const output = count(usage.outputTokens);
	const input = count(usage.inputTokens);
	const cacheRead = count(usage.cacheReadTokens);
	const cacheWrite = count(usage.cacheWriteTokens);
	const total = output + input + cacheRead + cacheWrite;
	if (total <= 0) return undefined;
	return { total, output, input: input + cacheRead + cacheWrite };
}

/**
 * Fold one session event into the per-reply token series.
 *
 * One reply is one complete answer to a user prompt: the whole turn, which may
 * span several `assistant/message` events (steps) when tools run between them.
 * The chart compares replies, so every settled message in the same turn is
 * summed into that turn's single sample; a message whose turn is unknown keeps
 * its own sample. Events that do not concern the unit return the same state
 * reference, so the projection seam does no downstream work for them.
 * @param state - current series samples.
 * @param event - committed session event.
 * @returns the unchanged state, or a new sample list.
 */
export function foldTokenSeries(state, event) {
	if (event?.type !== "assistant/message") return state;
	const usage = tokenTotal(event.data?.usage);
	if (usage === undefined) return state;
	const at = typeof event.time === "number" && Number.isFinite(event.time) ? event.time : 0;
	const turn = typeof event.data?.turn === "number" && Number.isFinite(event.data.turn) ? event.data.turn : undefined;
	const last = state[state.length - 1];
	if (turn !== undefined && last !== undefined && last.turn === turn) {
		// Same turn: fold this step's usage into the reply already open for it.
		const merged = {
			...last,
			total: last.total + usage.total,
			output: last.output + usage.output,
			input: last.input + usage.input,
			at,
		};
		return [...state.slice(0, -1), merged];
	}
	const sample = {
		total: usage.total,
		output: usage.output,
		input: usage.input,
		at,
		...(turn === undefined ? {} : { turn }),
	};
	const next = [...state, sample];
	return next.length > TOKEN_SERIES_LIMIT ? next.slice(next.length - TOKEN_SERIES_LIMIT) : next;
}

/**
 * Validate one token sample, whatever the seam hands back.
 * @param value - candidate sample.
 * @param where - label used in the failure message.
 * @returns the same sample when it is well formed.
 * @throws TypeError when a field is missing or not a non-negative number.
 */
function assertTokenSample(value, where) {
	if (value === null || typeof value !== "object") throw new TypeError(`${where} must be an object`);
	for (const field of ["total", "output", "input", "at"]) {
		const number = value[field];
		if (typeof number !== "number" || !Number.isFinite(number) || number < 0) {
			throw new TypeError(`${where}.${field} must be a non-negative number`);
		}
	}
	if (value.turn !== undefined && (!Number.isFinite(value.turn) || value.turn < 0)) {
		throw new TypeError(`${where}.turn must be a non-negative number when present`);
	}
	return value;
}

/**
 * Validate one token sample list.
 * @param value - candidate list.
 * @param where - label used in the failure message.
 * @returns the same list when every sample is well formed.
 */
function assertTokenSamples(value, where) {
	if (!Array.isArray(value)) throw new TypeError(`${where} must be an array`);
	for (const [index, sample] of value.entries()) assertTokenSample(sample, `${where}[${index}]`);
	return value;
}

/**
 * The projection seam validates both the persisted state and the client view
 * with `.parse()`, so a unit without them breaks every session load that
 * restores a checkpoint. These schemas are the validation contract the seam
 * calls; they keep the package dependency-free instead of pulling in a schema
 * library for four numbers.
 */
const tokenSamplesSchema = {
	parse: (value) => assertTokenSamples(value, "balanceUsageDockTokens"),
};

/**
 * The `balanceUsageDockTokens` projection unit: one sample per complete reply
 * (turn). A turn's several settled `assistant/message` steps are summed into
 * that turn's single sample, so the chart compares whole replies.
 *
 * `stateVersion` gates every persisted checkpoint row, so bumping it discards
 * rows written by an older fold instead of migrating them (and it is how a row
 * written before the schemas existed stops being read). Bumped from 2 when the
 * fold changed from per-message samples to per-turn samples.
 */
export const tokenSeriesProjection = {
	key: "balanceUsageDockTokens",
	stateVersion: 3,
	stateSchema: tokenSamplesSchema,
	init: () => [],
	apply: foldTokenSeries,
	wire: {
		viewSchema: tokenSamplesSchema,
		view: (state) => state.slice(Math.max(0, state.length - TOKEN_SERIES_VIEW)),
	},
};

/**
 * Read one session's newest per-response token samples.
 * @param ctx - Host context carrying the session services.
 * @param sessionId - requested session identity; an unknown one falls back to the newest live session.
 * @returns the samples, the identity they came from, and whether a session was found.
 */
export function readTokenSeries(ctx, sessionId) {
	const projections = ctx.get("sessionProjections");
	const sessions = ctx.get("sessions");
	if (sessions === undefined || projections === undefined) return { samples: [], session: undefined };
	const requested = typeof sessionId === "string" && sessionId !== "" ? sessions.get(sessionId) : undefined;
	const session = requested ?? sessions.list().at(-1);
	if (session === undefined) return { samples: [], session: undefined };
	const state = projections.stateOf(session, tokenSeriesProjection.key);
	const samples = Array.isArray(state) ? state.slice(Math.max(0, state.length - TOKEN_SERIES_VIEW)) : [];
	return { samples, session: session.id };
}

/**
 * Poll one account summary and fold it into a compact sample.
 * @param config - normalized plugin config.
 * @param credentials - Host credential service.
 * @returns a sample, or a signed-out/failed marker.
 */
async function readSample(config, credentials) {
	let record;
	try {
		record = await credentials?.readRecord(config.credentialKey);
	} catch {
		return { status: "failed" };
	}
	if (record === undefined) return { status: "signed-out" };
	const payload = record?.kind === "grant" ? record.payload : undefined;
	if (typeof payload?.token !== "string" || payload.token === "") return { status: "failed" };
	if (normalizeOrigin(payload.issuer) !== config.platformOrigin) return { status: "failed" };

	let response;
	try {
		response = await fetch(`${config.platformOrigin}${SUMMARY_PATH}`, {
			method: "GET",
			headers: { "x-dsh-auth-token": payload.token, accept: "application/json" },
			redirect: "error",
			signal: AbortSignal.timeout(config.requestTimeoutMs),
		});
	} catch {
		return { status: "failed" };
	}
	if (!response.ok) {
		await response.body?.cancel?.();
		return { status: "failed" };
	}
	let body;
	try {
		body = await response.json();
	} catch {
		return { status: "failed" };
	}
	const summary = summarize(body);
	if (summary === undefined) return { status: "failed" };
	return { status: "ready", at: Date.now(), ...summary };
}

/**
 * Host half: start the poller and publish the Client snapshot route.
 * @param ctx - Host context carrying `webServer` and `credentials`.
 * @param rawConfig - plugin row config; every field is optional.
 * @returns disposer releasing the timer, the samples and the route.
 */
export function apply(ctx, rawConfig) {
	const config = normalizeConfig(rawConfig);
	if (!config.enabled) return;

	/** @type {{at: number, cost: number|undefined, costKnown: boolean}[]} */
	let samples = [];
	let lastGood;
	let signedOut = false;
	let failedReason;

	const timezoneOffsetMinutes = () => -new Date().getTimezoneOffset();
	const hasCost = () => samples.some((sample) => sample.costKnown);

	/** Fold one poll result into the rolling window. */
	function fold(result) {
		if (result === undefined) return;
		if (result.status === "signed-out") {
			signedOut = true;
			failedReason = undefined;
			return;
		}
		if (result.status !== "ready") {
			failedReason = "platform summary unavailable";
			return;
		}
		signedOut = false;
		failedReason = undefined;
		lastGood = result;
		const previous = samples[samples.length - 1];
		if (previous !== undefined && previous.costKnown && result.cost !== undefined && result.cost < previous.cost) {
			// A counter that moves backwards means a different account or a reset
			// series: restart the window rather than report negative use.
			samples = [];
		}
		samples.push({ at: result.at, cost: result.cost, costKnown: result.cost !== undefined });
		const floor = result.at - KEEP_MS;
		let drop = 0;
		while (drop < samples.length && samples[drop].at < floor) drop++;
		if (drop > 0) samples = samples.slice(drop);
	}

	/**
	 * Build the Client snapshot.
	 * @param sessionId - session the browser is showing; the newest live session answers when it is unknown.
	 */
	function snapshot(sessionId) {
		const now = Date.now();
		const tokens = readTokenSeries(ctx, sessionId);
		// The chart compares responses, so it always carries the session's token
		// samples; the balance block only changes with the account read.
		const base = {
			serverTime: now,
			timezoneOffsetMinutes: timezoneOffsetMinutes(),
			pollIntervalMs: config.pollIntervalMs,
			responses: tokens.samples,
			tokenSession: tokens.session,
		};
		if (signedOut) return { ...base, status: "signed-out" };
		if (lastGood === undefined) return { ...base, status: failedReason === undefined ? "loading" : "unavailable" };
		const symbol = lastGood.currency === "USD" ? "$" : lastGood.currency === "CNY" ? "¥" : "";
		const spent = hasCost() && samples.length > 1
			? Math.max(0, samples[samples.length - 1].cost - samples[0].cost)
			: undefined;
		// Platform Web truncates each wallet to cents before showing it, so the
		// dock's headline is the plain sum of those displayed rows.
		const wallets = balanceRows(lastGood.wallets ?? [], symbol);
		const shownBalance = wallets.reduce((total, wallet) => total + wallet.shown, 0);
		return {
			...base,
			status: "ready",
			currency: lastGood.currency,
			symbol,
			balance: lastGood.balance,
			balanceText: formatMoney(shownBalance, symbol),
			wallets,
			isSplit: wallets.filter((wallet) => wallet.amount > 0).length > 1,
			cost: lastGood.cost,
			spentSinceStart: spent,
			spentText: spent === undefined ? undefined : formatSpend(spent, symbol),
			updatedAt: lastGood.at,
			error: failedReason,
		};
	}

	/** One poll; failures are retained as the snapshot's reason. */
	async function poll() {
		try {
			fold(await readSample(config, ctx.get("credentials")));
		} catch (error) {
			failedReason = error instanceof Error ? error.message : String(error);
		}
	}

	// The per-response token series is derived state owned by the session log, so
	// it lives in the projection registry instead of a listener that rescans.
	const projections = ctx.get("sessionProjections");
	if (projections !== undefined) projections.register(tokenSeriesProjection);

	const timer = setInterval(() => {
		void poll();
	}, config.pollIntervalMs);
	if (typeof timer.unref === "function") timer.unref();
	void poll();

	const disposeRoute = ctx.get("webServer")?.register({
		kind: "prefix",
		path: ROUTE_PATH,
		handler(request, response) {
			if (request.method !== "GET" && request.method !== "HEAD") {
				response.writeHead(405, { allow: "GET, HEAD" });
				response.end();
				return;
			}
			const origin = request.headers.origin;
			let allowedOrigin;
			if (typeof origin === "string") {
				try {
					allowedOrigin = new URL(origin).origin;
				} catch {
					allowedOrigin = undefined;
				}
				if (allowedOrigin === undefined || !isAllowedOrigin(allowedOrigin)) {
					response.writeHead(403);
					response.end();
					return;
				}
			}
			let sessionId;
			try {
				sessionId = new URL(request.url ?? "/", "http://dsh.invalid").searchParams.get("session") ?? undefined;
			} catch {
				sessionId = undefined;
			}
			const payload = Buffer.from(JSON.stringify(snapshot(sessionId)), "utf8");
			response.writeHead(200, {
				"content-type": "application/json; charset=utf-8",
				"cache-control": "no-store",
				"content-length": String(payload.byteLength),
				...(allowedOrigin === undefined ? {} : { "access-control-allow-origin": allowedOrigin, vary: "origin" }),
			});
			response.end(request.method === "HEAD" ? undefined : payload);
		},
	});

	return () => {
		clearInterval(timer);
		disposeRoute?.();
		samples = [];
	};
}

export const name = "dsh-balance-usage-dock";
export const inject = ["webServer", "credentials", "sessions", "sessionProjections"];
