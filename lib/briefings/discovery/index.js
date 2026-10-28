import { DEFAULT_DISCOVERY, DISCOVERY_MAXIMUMS } from "../../briefing-rules.js";
import { dedupeItems, toItem } from "../dedupe.js";
import { BudgetStop } from "../meter.js";
import { queryPrompt } from "../prompts.js";
import { ProviderError, isAuthFailure, scrubSecret } from "../providers.js";
import { readablePage } from "../readable.js";
import { canonicalUrl, hostOf, isSameSite } from "../urls.js";
import candidateFeed from "./candidate-feed.js";
import { DiscoveryAuthError, DiscoveryLimitError } from "./errors.js";
import gdelt from "./gdelt.js";
import hn from "./hn.js";
import outletFeeds from "./outlet-feeds.js";
import { markExhausted, takeSlot, windowEnd } from "./pacing.js";
import tinyfish from "./tinyfish.js";

// Open-web discovery (docs/BRIEFINGS-DESIGN.md, Open-web discovery): queries from the brief, the free indexes, the account's own
// search provider, the trusted outlets' feeds and an owner's candidate feed, then one hop along the outbound links of the
// strongest articles. Every adapter call goes through callAdapter: paced on DiscoveryUsage per account, provider, key and
// operation; a minute's limit is waited out when that fits the tick, else the rest is carried to the next tick; an hour's or a
// day's limit stops that provider for the window; a refused key is marked rejected and the run goes on without it. The state is
// kept in work.discovery, so a run cut off here resumes where it was.
export const ADAPTERS = { gdelt, hn, "outlet-feeds": outletFeeds, tinyfish, "candidate-feed": candidateFeed };
export const MAX_MINUTE_WAIT_MS = 60_000;
const TASKS_PER_PASS = 8;
const SOCIAL = /(?:^|\.)(?:twitter\.com|x\.com|facebook\.com|linkedin\.com|instagram\.com|youtube\.com|tiktok\.com|pinterest\.com|reddit\.com|t\.me|wa\.me|whatsapp\.com|bsky\.app|threads\.net|mastodon\.social)$/;
const NOT_ARTICLES = /\/(?:tag|tags|category|author|search|login|signin|signup|subscribe|share|intent|sharer|privacy|terms|about|contact)(?:\/|$)|\.(?:jpe?g|png|gif|webp|svg|zip|mp3|mp4)$/i;

export function discoverySettings(briefing) {
	const own = briefing.discovery ?? {};
	const pick = (name) => {
		const value = Number(own[name]);
		return Number.isFinite(value) && value >= 0 ? Math.min(value, DISCOVERY_MAXIMUMS[name]) : DEFAULT_DISCOVERY[name];
	};
	return Object.fromEntries(Object.keys(DEFAULT_DISCOVERY).map((name) => [name, pick(name)]));
}

// Where a run's lookback starts: lookbackHours before `at`, or mondayLookbackHours when `at` is a Monday in the schedule's time zone.
// Not the last run's time: a manual run an hour after the last one would only see that hour's news.
export function lookbackStart(briefing, at) {
	const settings = discoverySettings(briefing);
	const time = new Date(at);
	let weekday;
	try {
		weekday = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: briefing.schedule?.timeZone || "UTC" }).format(time);
	} catch {
		weekday = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "UTC" }).format(time);
	}
	const hours = Math.max(1, weekday === "Mon" ? settings.mondayLookbackHours : settings.lookbackHours);
	return new Date(time.getTime() - hours * 60 * 60_000);
}

function note(ctx, { provider, problem, scope, until }) {
	const notes = ctx.run.discoveryNotes;
	if (notes.some((entry) => entry.provider === provider && entry.scope === scope && entry.problem === problem)) return;
	if (notes.length < 50) notes.push({ provider, problem: String(problem).slice(0, 300), scope, ...(until && { until: new Date(until) }) });
}

// Queries: one call to the query step's model (the extract step's when the briefing sets none), else the topic and the examples'
// notes. Code adds a query per trusted outlet for providers that can search one site.
export async function planQueries(ctx, { settings, kept }) {
	const { briefing } = ctx;
	const topic = String(briefing.brief?.topic ?? "").trim() || briefing.name;
	let queries = [];
	const step = briefing.steps?.query?.keyId ? "query" : briefing.steps?.extract?.keyId ? "extract" : null;
	if (step && settings.maxQueries > 0) {
		try {
			const { key, model } = await ctx.keyFor(step);
			const { system, user, maxTokens } = queryPrompt({ briefing, kept, maxQueries: settings.maxQueries });
			const { json } = await ctx.models.text({ key, model, step: "query", system, user, json: true, maxTokens, temperature: 0.3 });
			queries = (Array.isArray(json?.queries) ? json.queries : []).map((entry) => ({ text: String(entry?.text ?? "").replace(/\s+/g, " ").trim().slice(0, 120), angle: String(entry?.angle ?? "").slice(0, 80) }));
		} catch (error) {
			// A refused key fails the run here, before any search is spent on it; anything else falls back to the brief.
			if (isAuthFailure(error) || (!(error instanceof BudgetStop) && !(error instanceof ProviderError) && error?.name !== "UnknownPrice")) throw error;
			note(ctx, { provider: "queries", problem: `Queries came from the topic only: ${ctx.describe(error)}`, scope: error instanceof BudgetStop ? "budget" : "error" });
			ctx.work.partial = true;
		}
	}
	if (!queries.length) queries = [{ text: topic.slice(0, 120), angle: "topic" }, ...(briefing.brief?.examples ?? []).filter(({ note: text }) => text).map(({ note: text }) => ({ text: text.slice(0, 120), angle: "example" }))];
	const seen = new Set();
	const unique = queries.filter(({ text }) => text && !seen.has(text.toLowerCase()) && seen.add(text.toLowerCase())).slice(0, Math.max(1, settings.maxQueries));
	// Each trusted outlet gets one of the run's own queries, in turn, limited to its site: the topic is a paragraph, and a search
	// engine given a paragraph finds little.
	const sites = (briefing.trustedOutlets ?? []).map((host, index) => ({ text: unique[index % unique.length].text, angle: `trusted outlet ${host}`, site: host }));
	return [...unique, ...sites];
}

// The providers this run asks, and the ids of the keys they use. Only the ids are kept in the run's state, which is saved: each
// call loads its key again through the run's key loader, so a decrypted key is never written to the database.
async function providersFor(ctx) {
	const { briefing } = ctx;
	const list = [{ id: "gdelt" }, { id: "hn" }];
	for (const [field, kinds] of [
		["searchKeyId", ["tinyfish", "candidate-feed"]],
		["candidateFeedKeyId", ["candidate-feed"]],
	]) {
		const keyId = briefing.discovery?.[field];
		if (!keyId) continue;
		try {
			const key = await ctx.searchKey(keyId);
			if (!key) note(ctx, { provider: "search", problem: "The search key was removed", scope: "auth" });
			else if (!kinds.includes(key.provider)) note(ctx, { provider: key.provider, problem: `${key.provider} can't be used for discovery`, scope: "error" });
			else if (!list.some(({ keyId: other }) => other === String(keyId))) list.push({ id: key.provider, keyId: String(keyId) });
		} catch (error) {
			note(ctx, { provider: "search", problem: ctx.describe(error), scope: "error" });
			ctx.work.partial = true;
		}
	}
	return list;
}

// One paced call. Answers { value } or { skip: true } (the provider is off for now) or { carry: true } (wait for the next tick).
export async function callAdapter(ctx, { provider, operation = "search", args, state = ctx.work.discovery }) {
	const adapter = ADAPTERS[provider.id];
	const off = state.off[provider.id];
	if (off && (off === "run" || new Date(off) > ctx.clock())) return { skip: true };
	const limits = (operation === "fetch" ? adapter.fetchLimits : adapter.limits) ?? {};
	const keyId = provider.keyId ?? "";
	const secret = provider.key?.secret ?? "";
	const stopFor = async (scope, until, problem) => {
		state.off[provider.id] = until ? new Date(until).toISOString() : "run";
		await markExhausted({ accountId: ctx.run.accountId, provider: provider.id, keyId, operation, scope, until: new Date(until ?? windowEnd(scope, ctx.clock())), now: ctx.clock() });
		note(ctx, { provider: provider.id, problem, scope, until });
		return { skip: true };
	};
	// Discovery spends nothing unless the owner raised discoveryBudgetUsd: a paid adapter, or one whose calls began to cost,
	// stops when the run's discovery spend would pass it.
	const budget = discoverySettings(ctx.briefing ?? {}).discoveryBudgetUsd;
	if ((adapter.paid || state.costUsd > 0) && state.costUsd >= budget) {
		state.off[provider.id] = "run";
		note(ctx, { provider: provider.id, problem: budget > 0 ? `Discovery reached its $${budget.toFixed(2)} budget` : "Paid search is off: the briefing's discovery budget is $0", scope: "budget" });
		return { skip: true };
	}
	for (let attempt = 0; attempt < 2; attempt++) {
		const now = ctx.clock();
		if (adapter.minIntervalMs && state.lastAt[provider.id]) {
			const wait = state.lastAt[provider.id] + adapter.minIntervalMs - now.getTime();
			if (wait > 0) {
				if (!ctx.canWait(wait)) return { carry: true };
				await ctx.sleep(wait);
			}
		}
		const slot = await takeSlot({ accountId: ctx.run.accountId, provider: provider.id, keyId, operation, limits, now: ctx.clock() });
		if (!slot.ok) {
			const wait = slot.until.getTime() - ctx.clock().getTime();
			if (slot.scope === "minute" && wait <= MAX_MINUTE_WAIT_MS) {
				if (attempt === 0 && ctx.canWait(wait)) {
					await ctx.sleep(wait);
					continue;
				}
				return { carry: true };
			}
			state.off[provider.id] = slot.until.toISOString();
			note(ctx, { provider: provider.id, problem: `Its ${slot.scope}'s limit is used up`, scope: slot.scope, until: slot.until });
			return { skip: true };
		}
		state.lastAt[provider.id] = ctx.clock().getTime();
		try {
			const adapterCtx = {
				key: provider.key ?? null,
				fetchImpl: ctx.fetcher.api,
				fetchPage: ctx.fetcher.get,
				outlets: args.outlets,
				now: ctx.clock(),
				pace: (scope, { remaining, resetAt }) => {
					if (remaining === 0 && resetAt) state.pending.push({ scope, resetAt: resetAt.toISOString(), provider: provider.id, operation });
				},
			};
			const value = await adapter[operation](args, adapterCtx);
			state.costUsd += value?.usage?.costUsd ?? 0;
			for (const { scope, resetAt, provider: id, operation: done } of state.pending.splice(0)) {
				await markExhausted({ accountId: ctx.run.accountId, provider: id, keyId, operation: done, scope, until: new Date(resetAt), now: ctx.clock() });
			}
			return { value };
		} catch (error) {
			const problem = scrubSecret(error?.message ?? error, secret);
			if (error instanceof DiscoveryLimitError) {
				if (error.scope === "minute") {
					const wait = Math.min(error.retryAfterMs ?? MAX_MINUTE_WAIT_MS, MAX_MINUTE_WAIT_MS);
					if (attempt === 0 && ctx.canWait(wait)) {
						await ctx.sleep(wait);
						continue;
					}
					return { carry: true };
				}
				return stopFor(error.scope, error.retryAfterMs ? ctx.clock().getTime() + error.retryAfterMs : windowEnd(error.scope, ctx.clock()), problem);
			}
			if (error instanceof DiscoveryAuthError) {
				state.off[provider.id] = "run";
				note(ctx, { provider: provider.id, problem, scope: "auth" });
				ctx.work.partial = true;
				if (provider.keyId) await ctx.keyRejected({ keyId: provider.keyId, provider: provider.id });
				return { skip: true };
			}
			state.errors[provider.id] = (state.errors[provider.id] ?? 0) + 1;
			if (state.errors[provider.id] >= 2) state.off[provider.id] = "run";
			note(ctx, { provider: provider.id, problem, scope: "error" });
			ctx.work.partial = true;
			return { skip: true };
		}
	}
	return { carry: true };
}

async function merge(ctx, found, foundBy) {
	const state = ctx.work.discovery;
	for (const raw of found) {
		if (state.results.length >= state.maxResults) break;
		const item = await toItem({ ...raw, foundBy });
		if (!item || ctx.fetcher.isBlocked(item.url)) continue;
		const known = state.results.find((each) => each.urlHash === item.urlHash);
		if (known) {
			if (!known.foundBy.includes(foundBy)) known.foundBy.push(foundBy);
			known.excerpt ||= item.excerpt;
			known.publishedAt ||= item.publishedAt;
			continue;
		}
		state.results.push({ ...item, foundBy: [foundBy] });
	}
	ctx.run.counts.results += found.length;
}

async function runTask(ctx, task, settings) {
	const state = ctx.work.discovery;
	const listed = task.provider === "outlet-feeds" ? { id: "outlet-feeds" } : state.providers.find(({ id, keyId }) => id === task.provider && (keyId ?? "") === (task.keyId ?? ""));
	if (!listed) return { done: true };
	let provider = { id: listed.id, keyId: listed.keyId };
	if (listed.keyId) {
		const key = await ctx.searchKey(listed.keyId).catch(() => null);
		if (!key) {
			note(ctx, { provider: listed.id, problem: "The search key was removed", scope: "auth" });
			state.off[listed.id] = "run";
			return { done: true };
		}
		provider = { ...provider, key };
	}
	const query = task.query === undefined ? null : state.queries[task.query];
	if (query?.site && !ADAPTERS[provider.id].supports.site) return { done: true };
	const args = {
		query: query?.text ?? "",
		site: query?.site,
		since: state.since,
		language: ctx.briefing.languages?.[0],
		max: provider.id === "candidate-feed" ? 100 : settings.resultsPerQuery,
		outlets: task.outlets,
	};
	const outcome = await callAdapter(ctx, { provider, args });
	if (outcome.carry) return { carry: true };
	if (outcome.value) {
		await merge(ctx, outcome.value.results ?? [], query ? `${provider.id}:${query.text}` : provider.id);
		if (outcome.value.feeds) Object.assign(state.feeds, outcome.value.feeds);
		for (const { host, problem } of outcome.value.problems ?? []) note(ctx, { provider: `outlet-feeds:${host}`, problem, scope: problem.includes("robots.txt") ? "robots" : "error" });
	}
	return { done: true };
}

// The best tenth of the candidates by what is known without a model, their pages read once for outbound links (one hop, same
// run). A link becomes a candidate of its own.
async function followLinks(ctx, candidates, settings) {
	if (!settings.followLinks) return [];
	const trusted = ctx.briefing.trustedOutlets ?? [];
	const score = (item) => item.foundBy.length + (trusted.some((host) => isSameSite(`https://${host}/`, item.url)) ? 2 : 0) + (item.publishedAt ? 1 : 0);
	const strong = [...candidates].sort((a, b) => score(b) - score(a)).slice(0, Math.min(20, Math.ceil(candidates.length / 10)));
	const found = [];
	for (const item of strong) {
		if (!ctx.hasTime()) break;
		let page;
		try {
			const fetched = await ctx.fetcher.get(item.url);
			page = readablePage(fetched.text, fetched.url);
			ctx.work.resolved[item.url] = "ok";
		} catch (error) {
			if (error?.robots) note(ctx, { provider: "fetch", problem: `robots.txt refused ${hostOf(item.url)}`, scope: "robots" });
			continue;
		}
		const links = [];
		for (const link of page.links) {
			const url = canonicalUrl(link.url);
			if (!url || links.length >= settings.followLinks) continue;
			const host = hostOf(url);
			if (isSameSite(url, item.url) || SOCIAL.test(host) || NOT_ARTICLES.test(new URL(url).pathname) || new URL(url).pathname === "/" || ctx.fetcher.isBlocked(url) || link.text.length < 8) continue;
			if (!links.some((each) => each.url === url)) links.push({ url, title: link.text, snippet: "", publishedAt: null, publisher: host });
		}
		found.push(...links.map((link) => ({ ...link, foundBy: `link:${hostOf(item.url)}` })));
	}
	return found;
}

// The discover stage's work, a pass at a time: { done } when the candidates are in work.fresh, else { partial } or { yield }.
export async function runDiscovery(ctx) {
	const { briefing, run, work } = ctx;
	const settings = discoverySettings(briefing);
	work.discovery ??= { phase: "queries", tasks: [], results: [], off: {}, lastAt: {}, errors: {}, feeds: {}, pending: [], costUsd: 0, maxResults: settings.maxCandidates * 2 };
	const state = work.discovery;
	work.resolved ??= {};
	if (!state.since) state.since = lookbackStart(briefing, run.startedAt ?? ctx.clock()).toISOString();

	if (state.phase === "queries") {
		const kept = (await ctx.history()).filter(({ verdict, decidedAt }) => verdict === "keep" && ctx.clock() - new Date(decidedAt) < 7 * 24 * 60 * 60_000).slice(0, 10);
		state.queries = await planQueries(ctx, { settings, kept });
		run.queries = state.queries.map(({ text, angle }) => ({ text, angle }));
		run.counts.queries = run.queries.length;
		state.providers = await providersFor(ctx);
		const outlets = await ctx.outletsToRead();
		if (outlets.length) state.tasks.push({ provider: "outlet-feeds", outlets });
		for (const provider of state.providers.filter(({ id }) => !ADAPTERS[id].perQuery)) state.tasks.push({ provider: provider.id, keyId: provider.keyId });
		state.queries.forEach((_, index) => {
			for (const provider of state.providers.filter(({ id }) => ADAPTERS[id].perQuery)) state.tasks.push({ provider: provider.id, keyId: provider.keyId, query: index });
		});
		state.phase = "search";
		return { partial: true };
	}

	if (state.phase === "search") {
		let done = 0;
		while (state.tasks.length && done < TASKS_PER_PASS) {
			if (!ctx.hasTime()) return { partial: true };
			const outcome = await runTask(ctx, state.tasks[0], settings);
			if (outcome.carry) return { yield: true };
			state.tasks.shift();
			done += 1;
		}
		if (state.tasks.length) return { partial: true };
		state.phase = "follow";
		return { partial: true };
	}

	if (state.phase === "follow") {
		const first = await dedupeItems({ items: state.results, seen: ctx.seen, since: state.since });
		const candidates = first.slice(0, settings.maxCandidates);
		const linked = [];
		for (const raw of await followLinks(ctx, candidates, settings)) {
			const item = await toItem(raw);
			if (item && !candidates.some(({ urlHash }) => urlHash === item.urlHash) && !linked.some(({ urlHash }) => urlHash === item.urlHash)) linked.push({ ...item, foundBy: [raw.foundBy] });
		}
		const followed = await dedupeItems({ items: linked, seen: ctx.seen, since: null });
		work.fresh = [...candidates, ...followed].slice(0, settings.maxCandidates);
		run.counts.candidates = state.results.length + linked.length;
		run.counts.fresh = work.fresh.length;
		work.publisherFeeds = state.feeds;
		work.since = state.since;
		work.discoveryCostUsd = state.costUsd;
		delete work.discovery;
		return { done: true };
	}
	return { done: true };
}

// A page our own fetch got but couldn't read as text, fetched by the account's search provider instead: only when it has a fetch,
// after the same robots.txt and blocked-host check, paced on its fetch limits. Never for a page that refused us.
export function providerFetcher(ctx) {
	return async (url) => {
		const keyId = ctx.briefing.discovery?.searchKeyId;
		if (!keyId || ctx.fetcher.isBlocked(url)) return null;
		const key = await ctx.searchKey(keyId).catch(() => null);
		if (!key || !ADAPTERS[key.provider]?.supports.fetch) return null;
		if (!(await ctx.fetcher.allowedByRobots(url))) return null;
		ctx.work.fetchPacing ??= { off: {}, lastAt: {}, errors: {}, pending: [], costUsd: 0 };
		const outcome = await callAdapter(ctx, { provider: { id: key.provider, key, keyId: String(keyId) }, operation: "fetch", args: { url }, state: ctx.work.fetchPacing });
		if (!outcome.value || outcome.value.refused || !outcome.value.text) return null;
		return { text: outcome.value.text, title: outcome.value.title, links: outcome.value.links, finalUrl: outcome.value.finalUrl };
	};
}

