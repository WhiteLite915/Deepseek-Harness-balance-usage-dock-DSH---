/**
 * Browser half of the Balance & Usage Dock plugin.
 *
 * Reads the Host snapshot from `/dsh-balance-usage/state?session=...` and
 * renders three parts in `conversation.composer.dock`, immediately left of the
 * Harness "Performance & usage" pills:
 *
 *   1. the account balance — always visible;
 *   2. today's spend    — hidden when the row runs out of room;
 *   3. a per-response token chart — hidden first, and shrunk before that.
 *
 * The registration id MUST be the package name. The Host composes every
 * `dsh.client` bundle into the boot graph under that id and checks
 * `factories.has(id)` after the script runs; a different id makes the loader
 * treat the bundle as unregistered, execute it a second time, and fail the
 * whole Web boot with `duplicate factory registration`.
 */
window.__ModuleLoader__.load({
	id: '@deepseek-harness/dsh-balance-usage-dock',
	factory(require) {
		const React = require('react');
		const h = React.createElement;
		const { useEffect, useLayoutEffect, useMemo, useRef, useState } = React;

		const STATE_URL = '/dsh-balance-usage/state';
		const CLIENT_POLL_MS = 5000;
		const LOCAL_STORAGE_KEY = 'dsh-balance-usage-dock:day';
		/** Chart geometry: the widest form, the compact form, and the bar area. */
		const CHART_WIDTH = 64;
		const CHART_WIDTH_COMPACT = 38;
		const CHART_HEIGHT = 18;
		/** Component gaps, mirroring the stylesheet below. */
		const GAP = 12;
		const ITEM_GAP = 5;
		/** Rendered width of the row's other occupant, the performance pills. */
		const OTHER_WIDTH_ESTIMATE = 150;
		/** Space the ResizeObserver width may over-report before parts are hidden. */
		const SAFETY = 4;
		/** Responses the chart can draw. */
		const MAX_BARS = 40;
		/**
		 * First-render and test widths for the three parts. A browser overwrites
		 * them from the measurement layer on the first layout pass; the committed
		 * `data-width` values also let a headless test drive the same decision. They
		 * are deliberately generous so a first frame hides rather than overflows.
		 */
		const measureWidths = { balance: 110, today: 78, chart: 96 };

		/** Class names, prefixed with this plugin's own namespace. */
		const styles = {
			root: 'dshbud_root',
			item: 'dshbud_item',
			value: 'dshbud_value',
			chart: 'dshbud_chart',
			measure: 'dshbud_measure',
		};

		/** Component-scoped stylesheet, unmounted with the component. */
		const CSS = [
			'.dshbud_root{box-sizing:border-box;max-width:100%;font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;display:flex;align-items:center;gap:12px;white-space:nowrap}',
			'.dshbud_item{display:inline-flex;align-items:center;gap:5px;min-width:0}',
			'.dshbud_value{color:var(--dsw-alias-label-secondary)}',
			'.dshbud_chart{display:block;flex:none;overflow:visible}',
			// The measurement layer carries every part at off-screen coordinates so
			// each budget decision compares real rendered widths. It inherits the
			// same box, font and gap as the visible root, so the numbers match.
			'.dshbud_measure{box-sizing:border-box;position:absolute;top:0;left:-10000px;visibility:hidden;pointer-events:none;font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));font-variant-numeric:tabular-nums;display:flex;align-items:center;gap:12px;white-space:nowrap}',
		].join('');

		/** Locale strings; the Host language selects one set. */
		const COPY = {
			zh: {
				balance: '余额',
				today: '今日',
				usage: '用量',
				signedOut: '登录 DeepSeek 后显示余额与用量',
				loading: '正在读取余额…',
				unavailable: '暂时无法读取余额与用量，正在重试',
				noResponses: '本会话暂无回复用量',
				response: '第 {index} 次回复',
				tokens: '{count} tok',
				split: '输出 {output} · 输入 {input}',
				sessionSpend: '本次会话已消耗 {amount}',
			},
			en: {
				balance: 'Balance',
				today: 'Today',
				usage: 'Usage',
				signedOut: 'Sign in to DeepSeek to show balance and usage',
				loading: 'Reading balance…',
				unavailable: 'Balance and usage are unavailable; retrying',
				noResponses: 'No response usage in this session yet',
				response: 'Response {index}',
				tokens: '{count} tok',
				split: 'output {output} · input {input}',
				sessionSpend: 'This session spent {amount}',
			},
		};

		/** Pick the copy set for the active Host language. */
		function copyFor(locale) {
			return typeof locale === 'string' && locale.toLowerCase().startsWith('zh') ? COPY.zh : COPY.en;
		}

		/** Render `{placeholder}` slots in one locale string. */
		function fill(template, values) {
			return template.replace(/\{(\w+)\}/g, (whole, name) => (values[name] === undefined ? whole : String(values[name])));
		}

		/** The local calendar day key used by the stored cost baseline. */
		function dayKey(offsetMinutes) {
			const shifted = new Date(Date.now() + (Number.isFinite(offsetMinutes) ? offsetMinutes : 0) * 60000);
			return [
				shifted.getUTCFullYear(),
				String(shifted.getUTCMonth() + 1).padStart(2, '0'),
				String(shifted.getUTCDate()).padStart(2, '0'),
			].join('-');
		}

		/**
		 * Truncate a computed float to two decimals (spend deltas, never wallet
		 * text): positive amounts round down, so no cent is overstated.
		 */
		function truncateToCents(amount) {
			if (!Number.isFinite(amount)) return amount;
			if (amount < 0) return -truncateToCents(-amount);
			return Math.floor(Number((amount + Number.EPSILON).toFixed(7)) * 100) / 100;
		}

		/**
		 * Truncate exact decimal text to two fraction digits, the way Platform
		 * Web shows a wallet: 22.8366 -> 22.83, and a third digit of five or more
		 * still keeps the cent the amount already holds.
		 */
		function truncateDecimalText(value) {
			const negative = value.startsWith('-');
			const body = negative ? value.slice(1) : value;
			if (/[eE]/.test(body)) return truncateToCents(Number(body)).toFixed(2);
			const point = body.indexOf('.');
			const whole = point === -1 ? body : body.slice(0, point);
			const fraction = point === -1 ? '' : body.slice(point + 1);
			const kept = `${fraction}00`.slice(0, 2);
			return `${negative && !/^0*$/.test(`${whole}${kept}`) ? '-' : ''}${whole}.${kept}`;
		}

		/** Insert digit grouping into the integer part of decimal text. */
		function groupDigits(text) {
			const point = text.indexOf('.');
			const whole = point === -1 ? text : text.slice(0, point);
			return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${point === -1 ? '' : text.slice(point)}`;
		}

		/** Render a money amount with fixed decimals and digit grouping. */
		function formatMoney(amount, symbol, digits) {
			const fixed = amount.toFixed(digits);
			const negative = fixed.startsWith('-');
			return `${negative ? '-' : ''}${symbol}${groupDigits(negative ? fixed.slice(1) : fixed)}`;
		}

		/** Render spend: two truncated decimals, a sub-cent floor, then four below 0.1. */
		function formatSpend(amount, symbol) {
			if (amount > 0 && amount < 0.005) return `<${symbol}0.01`;
			if (amount < 0.1) return formatMoney(truncateToCents(amount), symbol, 4);
			return formatMoney(truncateToCents(amount), symbol, 2);
		}

		/** Compact token count for a label or tooltip. */
		function formatTokens(value) {
			if (!Number.isFinite(value)) return '0';
			if (value < 1000) return String(Math.round(value));
			if (value < 10000) return `${(value / 1000).toFixed(1)}k`;
			if (value < 1000000) return `${Math.round(value / 1000)}k`;
			return `${(value / 1000000).toFixed(1)}M`;
		}

		/**
		 * Balance rows the Host projected. Each row keeps the amount Platform
		 * sent, the truncated value it displays, and the display text itself, so
		 * the dock's headline sums displayed rows rather than a rounded total.
		 */
		function balanceRowsOf(payload) {
			const rows = Array.isArray(payload.wallets) ? payload.wallets : [];
			return rows
				.filter((row) => row !== null && typeof row === 'object' && Number.isFinite(row.amount))
				.map((row) => ({
					amount: row.amount,
					exact: typeof row.exact === 'string' ? row.exact : undefined,
					shown: Number.isFinite(row.shown) ? row.shown : truncateToCents(row.amount),
					display: typeof row.display === 'string' ? row.display : '',
				}))
				.filter((row) => row.display !== '');
		}

		/** One response's token sample, from the Host fold. */
		function responsesOf(payload) {
			const rows = Array.isArray(payload.responses) ? payload.responses : [];
			return rows
				.filter((row) => row !== null && typeof row === 'object')
				.map((row) => ({
					total: Number.isFinite(row.total) ? row.total : 0,
					output: Number.isFinite(row.output) ? row.output : 0,
					input: Number.isFinite(row.input) ? row.input : 0,
				}))
				.slice(-MAX_BARS);
		}

		/** Read the stored day baseline; storage may be unavailable. */
		function readStoredDay() {
			try {
				const raw = window.localStorage.getItem(LOCAL_STORAGE_KEY);
				if (raw === null) return null;
				const parsed = JSON.parse(raw);
				return parsed !== null && typeof parsed === 'object' && typeof parsed.day === 'string' && Number.isFinite(parsed.cost)
					? { day: parsed.day, cost: parsed.cost }
					: null;
			} catch {
				return null;
			}
		}

		/** Persist the day baseline; a storage failure only costs precision later. */
		function writeStoredDay(value) {
			try {
				window.localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(value));
			} catch {
				/* storage is optional */
			}
		}

		/**
		 * Today's spend from the lifetime cost counter.
		 *
		 * The Host counter is cumulative, so a daily figure needs a baseline taken
		 * on this local day. The baseline is remembered in local storage, so the
		 * first reading of a fresh day covers the rest of that day; the very first
		 * reading after installing the plugin has no baseline and shows nothing.
		 */
		function todaySpend(payload) {
			if (!Number.isFinite(payload.cost)) return undefined;
			const key = dayKey(payload.timezoneOffsetMinutes);
			const stored = readStoredDay();
			if (stored !== null && stored.day === key) return stored.cost <= payload.cost ? payload.cost - stored.cost : 0;
			writeStoredDay({ day: key, cost: payload.cost });
			return undefined;
		}

		/** Measure one element's rendered width, or 0 before it lays out. */
		function widthOf(node) {
			if (node === null || node === undefined) return 0;
			return typeof node.getBoundingClientRect === 'function' ? node.getBoundingClientRect().width : 0;
		}

		/**
		 * The element whose width is the row's available space. The slot outlet
		 * wraps this dock in a `display: contents` anchor that lays out at width
		 * zero, and the dock's own root only reports its shrink-to-fit content
		 * width. Climb past those zero-width ancestors to the flex row that
		 * actually grants the width, so the budget below measures the space left
		 * after the row's other occupants rather than the part already shown.
		 */
		function layoutHostOf(node) {
			if (node === null || node === undefined) return node;
			let cursor = node.parentElement;
			while (cursor !== null && cursor !== undefined) {
				if (widthOf(cursor) > 0) return cursor;
				cursor = cursor.parentElement;
			}
			return node;
		}

		/**
		 * Per-response token bars: one bar per reply, sized against the heaviest
		 * reply in the window so differences between replies are readable.
		 */
		const ResponseChart = React.memo(function ResponseChart({ responses, width }) {
			const frame = {
				className: styles.chart,
				width,
				height: CHART_HEIGHT,
				viewBox: `0 0 ${width} ${CHART_HEIGHT}`,
				'aria-hidden': true,
			};
			const tallest = responses.reduce((best, row) => Math.max(best, row.output), 0);
			if (responses.length === 0 || tallest <= 0) {
				return h(
					'svg',
					frame,
					h('line', {
						x1: 0,
						y1: CHART_HEIGHT - 0.75,
						x2: width,
						y2: CHART_HEIGHT - 0.75,
						stroke: 'var(--dsw-alias-border-l2)',
						strokeWidth: 1,
						vectorEffect: 'non-scaling-stroke',
					}),
				);
			}
			const bottom = CHART_HEIGHT - 0.5;
			const step = width / responses.length;
			const barWidth = Math.max(1, Math.min(4, step * 0.62));
			return h(
				'svg',
				frame,
				responses.map((row, index) => {
					const ratio = tallest <= 0 ? 0 : row.output / tallest;
					const height = Math.max(1.5, ratio * (CHART_HEIGHT - 2.5));
					const x = index * step + (step - barWidth) / 2;
					const newest = index === responses.length - 1;
					return h('rect', {
						key: `bar-${index}`,
						x: x.toFixed(2),
						y: (bottom - height).toFixed(2),
						width: barWidth.toFixed(2),
						height: height.toFixed(2),
						rx: Math.min(1, barWidth / 2),
						fill: newest ? 'var(--dsw-alias-label-secondary)' : 'var(--dsw-alias-state-business-primary)',
						opacity: newest ? 1 : 0.75,
					});
				}),
				h('line', {
					x1: 0,
					y1: bottom,
					x2: width,
					y2: bottom,
					stroke: 'var(--dsw-alias-border-l2)',
					strokeWidth: 1,
					vectorEffect: 'non-scaling-stroke',
				}),
			);
		});

		/** Balance and usage dock, left of the Harness performance pills. */
		function BalanceUsageDock(props) {
			// The locale arrives through the injected `useLocale` hook, so a
			// preference the Host delivers after activation re-renders the copy.
			// The plain prop and the browser language only stand in for a
			// composition whose locale service is absent.
			const injected = typeof props.useLocale === 'function' ? props.useLocale((snapshot) => snapshot?.active) : undefined;
			const locale = typeof injected === 'string' && injected !== ''
				? injected
				: typeof props.locale === 'string' && props.locale !== ''
					? props.locale
					: typeof navigator === 'object' && typeof navigator.language === 'string'
						? navigator.language
						: undefined;
			const copy = useMemo(() => copyFor(locale), [locale]);
			const sessionId = typeof props.sessionId === 'string' ? props.sessionId : undefined;
			const [payload, setPayload] = useState(null);
			const [width, setWidth] = useState(0);
			const [parts, setParts] = useState({ balance: 0, today: 0, chart: 0 });
			const rootRef = useRef(null);
			const measureRef = useRef(null);

			useEffect(() => {
				let active = true;
				let timer;
				const url = sessionId === undefined ? STATE_URL : `${STATE_URL}?session=${encodeURIComponent(sessionId)}`;
				const read = async () => {
					try {
						const response = await fetch(url, {
							method: 'GET',
							headers: { accept: 'application/json' },
							cache: 'no-store',
							credentials: 'omit',
						});
						const next = response.ok ? await response.json() : null;
						if (!active) return;
						if (next !== null && typeof next === 'object') setPayload(next);
					} catch {
						/* the Host route is not answering yet; the next tick retries */
					}
					if (active) timer = setTimeout(read, CLIENT_POLL_MS);
				};
				void read();
				return () => {
					active = false;
					clearTimeout(timer);
				};
			}, [sessionId]);

			// The composer dock is a centered flex row shared with the Harness
			// pills, so the space this plugin may spend is the row's width minus
			// the pills beside it. The visible row mounts one commit after the
			// first read (the root is absent while `payload` is null), so the
			// effect re-attaches when it appears; the root itself only reports its
			// shrink-to-fit content width, so the observer targets the laid-out
			// flex row that actually grants the width.
			useLayoutEffect(() => {
				const node = rootRef.current;
				if (node === null || typeof ResizeObserver !== 'function') return undefined;
				const host = layoutHostOf(node);
				const commit = (next) => setWidth((current) => (Math.abs(current - next) < 0.5 ? current : next));
				const observer = new ResizeObserver((entries) => {
					const entry = entries[0];
					const next = entry === undefined
						? widthOf(host)
						: entry.contentBoxSize?.[0]?.inlineSize ?? entry.contentRect?.width ?? widthOf(host);
					commit(next);
				});
				observer.observe(host);
				commit(widthOf(host));
				return () => observer.disconnect();
			}, [payload !== null]);

			// Measure the three parts on every render that can change their text:
			// the balance value, the today value and the chart's label. The numbers
			// only move the show/hide decision, so an unchanged set is discarded.
			useLayoutEffect(() => {
				const row = measureRef.current;
				if (row === null) return;
				const next = {
					balance: widthOf(row.children?.[0]),
					today: widthOf(row.children?.[1]),
					chart: widthOf(row.children?.[2]),
				};
				setParts((current) => (
					Math.abs(current.balance - next.balance) < 0.5
						&& Math.abs(current.today - next.today) < 0.5
						&& Math.abs(current.chart - next.chart) < 0.5
						? current
						: next
				));
			});

			const style = useMemo(() => h('style', { 'data-plugin-css': 'dsh-balance-usage-dock' }, CSS), []);
			const responses = payload === null ? [] : responsesOf(payload);
			const symbol = payload !== null && typeof payload.symbol === 'string' ? payload.symbol : '';
			const showing = payload !== null && payload.status === 'ready';
			const hasChart = responses.length > 0;

			// Budget: the width this dock was given, minus the pills beside it and a
			// small safety margin. Parts are considered in the order the dock drops
			// them — the chart first, then today — while the balance is never dropped.
			const budget = Math.max(0, width - OTHER_WIDTH_ESTIMATE - SAFETY);
			const balanceWidth = parts.balance > 0 ? parts.balance : measureWidths.balance;
			const todayWidth = parts.today > 0 ? parts.today : measureWidths.today;
			const chartWidth = parts.chart > 0 ? parts.chart : measureWidths.chart;
			const compactWidth = Math.max(CHART_WIDTH_COMPACT, Math.min(chartWidth, Math.round(chartWidth * 0.6)));
			const fits = (value) => value <= budget;
			// The row drops the chart before it drops today, so the chart is only
			// drawn with today when both fit; on its own it may shrink to the
			// compact form. The balance is never dropped.
			const fitBalanceToday = fits(balanceWidth + GAP + todayWidth);
			const showChartFull = showing && hasChart && fitBalanceToday && fits(balanceWidth + GAP + todayWidth + GAP + chartWidth);
			const showChartCompact = showing && hasChart && fitBalanceToday && !showChartFull && fits(balanceWidth + GAP + todayWidth + GAP + compactWidth);
			const showChart = showChartFull || showChartCompact;
			const showToday = showing && (showChart || fitBalanceToday);
			const drawChart = showChart;
			const chartDrawWidth = showChartFull ? chartWidth : compactWidth;

			/** One state of the dock: the stylesheet plus the row it draws. */
			const frame = (children, extra) =>
				h(
					React.Fragment,
					null,
					style,
					h('div', { className: styles.root, ref: rootRef, ...extra }, children),
				);

			// Every state renders the same off-screen measurement row, so the part
			// widths are already known when the ready state decides what fits. The
			// widths are declared on the parts, which is also how a test drives the
			// decision without a layout engine.
			const measureRow = (balanceValue, todayValue) =>
				h(
					'div',
					{ className: styles.measure, ref: measureRef, 'aria-hidden': true },
					h(
						'span',
						{ className: styles.item, 'data-width': measureWidths.balance },
						h('span', null, copy.balance),
						h('span', { className: styles.value }, balanceValue),
					),
					h(
						'span',
						{ className: styles.item, 'data-width': measureWidths.today },
						h('span', null, copy.today),
						h('span', { className: styles.value }, todayValue),
					),
					h(
						'span',
						{ className: styles.item, 'data-width': measureWidths.chart },
						h('span', null, copy.usage),
						h(ResponseChart, { responses, width: CHART_WIDTH }),
					),
				);
			const withMeasure = (children, balanceValue, todayValue) =>
				h(React.Fragment, null, style, measureRow(balanceValue, todayValue), children);

			if (payload === null) return withMeasure(null, '', '—');
			if (payload.status === 'signed-out') return withMeasure(frame(copy.signedOut, { title: copy.signedOut }), '', '—');
			if (payload.status === 'loading') return withMeasure(frame(copy.loading), '', '—');
			if (payload.status !== 'ready') {
				const reason = typeof payload.error === 'string' && payload.error !== '' ? payload.error : copy.unavailable;
				return withMeasure(frame(copy.unavailable, { title: reason }), '', '—');
			}

			const rows = balanceRowsOf(payload);
			// The headline sums the displayed wallet rows, so it always equals the
			// account page's own rows added up. A payload without rows falls back
			// to the Host text, then to a truncated exact total.
			const shownBalance = rows.length > 0 ? rows.reduce((total, row) => total + row.shown, 0) : undefined;
			const balanceText = rows.length > 0 && typeof payload.balanceText === 'string'
				? payload.balanceText
				: formatMoney(shownBalance ?? truncateToCents(payload.balance), symbol, 2);
			const balanceSplit = rows.length > 1 && rows.filter((row) => row.amount > 0).length > 1
				? ` (${rows.map((row) => row.display).join(' + ')})`
				: '';
			const today = todaySpend(payload);
			const todayText = today === undefined ? '—' : formatSpend(today, symbol);
			const newest = responses.length > 0 ? responses[responses.length - 1] : undefined;
			const chartText = newest === undefined
				? copy.noResponses
				: [
					`${copy.response.replace('{index}', String(responses.length))}: ${fill(copy.tokens, { count: formatTokens(newest.total) })}`,
					fill(copy.split, { output: formatTokens(newest.output), input: formatTokens(newest.input) }),
				].join(' · ');
			const tooltip = [
				`${copy.balance} ${formatMoney(payload.balance, symbol, 2)}${balanceSplit}`,
				`${copy.today} ${todayText}`,
				typeof payload.spentText === 'string' ? fill(copy.sessionSpend, { amount: payload.spentText }) : undefined,
				chartText,
			].filter((line) => line !== undefined).join('\n');

			const children = [
				h(
					'span',
					{ className: styles.item, key: 'balance' },
					h('span', null, copy.balance),
					h('span', { className: styles.value }, balanceText),
				),
			];
			if (showToday) {
				children.push(
					h(
						'span',
						{ className: styles.item, key: 'today' },
						h('span', null, copy.today),
						h('span', { className: styles.value }, todayText),
					),
				);
			}
			if (drawChart) {
				children.push(
					h(
						'span',
						{ className: styles.item, key: 'usage' },
						h('span', null, copy.usage),
						h(ResponseChart, { responses, width: chartDrawWidth }),
					),
				);
			}

			return withMeasure(
				h(
					'div',
					{
						className: styles.root,
						ref: rootRef,
						'data-balance-usage-dock': true,
						'data-parts': [showToday ? 'today' : undefined, drawChart ? 'chart' : undefined].filter(Boolean).join('+') || 'balance',
						title: tooltip,
						'aria-label': tooltip.replace(/\n/g, ', '),
					},
					children,
				),
				balanceText,
				todayText,
			);
		}

		return {
			// Only `slots` is required. `locale` is read when it is mounted, and a
			// profile without it still renders the dock with English copy.
			inject: ['slots'],
			apply(ctx) {
				// The locale source is a subscribe-able snapshot store, so it belongs
				// under `hooks`: the component then gets `useLocale` and re-renders
				// when the Host-backed language preference arrives or changes. A
				// static `locale` prop would freeze the first provisional value —
				// which is the browser language, not the DSH setting.
				//
				// A session-scoped slot calls `inject` with the session key, which is
				// how the dock asks the Host for that session's token samples.
				const locale = ctx.get('locale');
				ctx.slots.inject('conversation.composer.dock', () =>
					ctx.slots.register(
						{
							name: 'conversation.composer.dock',
							id: 'balance-usage-dock',
							order: -10,
							priority: -1,
							inject: (sessionId) => ({
								...(locale === undefined ? {} : { hooks: { locale } }),
								...(typeof sessionId === 'string' && sessionId !== '' ? { sessionId } : {}),
							}),
						},
						BalanceUsageDock,
					),
				);
			},
		};
	},
});
