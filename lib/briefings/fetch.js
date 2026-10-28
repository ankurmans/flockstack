import { getFeedUrlProblem } from "../feed-url.js";
import { LINK_CHECK, getLinkProblem, judgeStatus } from "../link-check-rules.js";
import { getPrivateHostProblem } from "../webhook-url.js";
import { ROBOTS, getRobotsRules, isAllowed } from "./robots.js";

// Every request the briefings engine makes to an address it didn't choose itself (docs/BRIEFINGS-DESIGN.md, Fetching): the
// briefing's blocked hosts, then the URL rule (https to a public name for pages, the link checker's rule for a draft's links),
// then every address the name resolves to must be public, then robots.txt for our user agent, and the same again on each
// redirect hop. 1 MB, 8 s, two at a time per host, 300 page fetches a run. The limits are the feed fetcher's
// (lib/feed-fetch.js FEED_LIMITS, which tests keep equal), kept here so the engine's Worker doesn't load the feed cache.
// Nothing here ever works around an answer: no cookies, one user agent, no other copy of a page; a 401, 403 or 429 is final.
export const FETCH_LIMITS = { bytes: 1_000_000, timeoutMs: 8000, redirects: 3, perHost: 2, perRun: 300 };
export const USER_AGENT = "FlockStack-Briefings/1.0 (+https://flockstack.io/docs/briefings-bot)";
export const FINAL_STATUSES = new Set([401, 403, 429]);
const DOH = "https://cloudflare-dns.com/dns-query";
const ROBOTS_REDIRECTS = 5;

export class FetchProblem extends Error {
	constructor(message, { status, final = false, robots = false } = {}) {
		super(message);
		this.name = "FetchProblem";
		this.status = status;
		this.final = final;
		this.robots = robots;
	}
}

function isWorkers() {
	return globalThis.navigator?.userAgent === "Cloudflare-Workers";
}

// The addresses a name resolves to: DNS over HTTPS in a Worker (which has no resolver of its own), the system's on Node.
export function createResolver({ fetchImpl = globalThis.fetch } = {}) {
	return async (host) => {
		if (isWorkers()) {
			const answers = await Promise.all(
				["A", "AAAA"].map(async (type) => {
					const response = await fetchImpl(`${DOH}?name=${encodeURIComponent(host)}&type=${type}`, { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(FETCH_LIMITS.timeoutMs) });
					if (!response.ok) throw new Error(`DNS answered ${response.status}`);
					const body = await response.json();
					return (body?.Answer ?? []).filter((answer) => answer?.type === 1 || answer?.type === 28).map((answer) => String(answer.data));
				})
			);
			return answers.flat();
		}
		const { lookup } = await import("node:dns/promises");
		return (await lookup(host, { all: true })).map(({ address }) => address);
	};
}

function addressProblem(address) {
	const host = address.includes(":") ? `[${address}]` : address;
	try {
		return getPrivateHostProblem(new URL(`https://${host}/`));
	} catch {
		return "That address can't be read";
	}
}

function hostOf(url) {
	return url.hostname.toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
}

export function isBlockedHost(url, blockedHosts = []) {
	const host = hostOf(url);
	return blockedHosts.some((blocked) => {
		const entry = String(blocked ?? "").trim().toLowerCase().replace(/^www\./, "");
		return entry && (host === entry || host.endsWith(`.${entry}`));
	});
}

async function readBody(response, limit) {
	const length = Number(response.headers.get("content-length"));
	if (length > limit) {
		await response.body?.cancel();
		throw new FetchProblem("the page is over 1 MB");
	}
	const reader = response.body?.getReader();
	if (!reader) return "";
	const chunks = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.length;
		if (size > limit) {
			await reader.cancel();
			throw new FetchProblem("the page is over 1 MB");
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.length;
	}
	const charset = /charset=["']?([\w-]+)/i.exec(response.headers.get("content-type") ?? "")?.[1];
	try {
		return new TextDecoder(charset || "utf-8").decode(bytes);
	} catch {
		return new TextDecoder().decode(bytes);
	}
}

// A run's fetcher. used: the page fetches the run made in earlier ticks, so the cap is per run, not per tick.
export function createFetcher({ fetchImpl = globalThis.fetch, resolveHost, blockedHosts = [], used = 0, perRun = FETCH_LIMITS.perRun, now = () => Date.now() } = {}) {
	const resolve = resolveHost ?? createResolver({ fetchImpl });
	let count = used;
	const active = new Map();
	const waiting = new Map();
	const resolved = new Map();

	async function withHost(host, task) {
		while ((active.get(host) ?? 0) >= FETCH_LIMITS.perHost) {
			await new Promise((wake) => waiting.set(host, [...(waiting.get(host) ?? []), wake]));
		}
		active.set(host, (active.get(host) ?? 0) + 1);
		try {
			return await task();
		} finally {
			active.set(host, active.get(host) - 1);
			const next = waiting.get(host)?.shift();
			if (next) next();
		}
	}

	// Throws when the address may not be opened: blocked for this briefing, or a name with any private address.
	async function assertPublic(url) {
		if (isBlockedHost(url, blockedHosts)) throw new FetchProblem("the briefing blocks this site", { final: true });
		const host = url.hostname.toLowerCase();
		if (host.startsWith("[") || /^[\d.]+$/.test(host)) {
			const problem = getPrivateHostProblem(url);
			if (problem) throw new FetchProblem(problem, { final: true });
			return;
		}
		if (!resolved.has(host)) {
			resolved.set(
				host,
				Promise.resolve()
					.then(() => resolve(host))
					.then(
						(addresses) => ({ addresses }),
						() => ({ addresses: [] })
					)
			);
		}
		const { addresses } = await resolved.get(host);
		if (!addresses.length) throw new FetchProblem("the name doesn't resolve", { final: true });
		const problem = addresses.map(addressProblem).find(Boolean);
		if (problem) throw new FetchProblem(`the name points inside a private network: ${problem}`, { final: true });
	}

	async function send(url, init, timeoutMs, { counted = true } = {}) {
		if (counted) {
			if (count >= perRun) throw new FetchProblem(`the run reached its ${perRun} fetches`);
			count += 1;
		}
		return withHost(new URL(url).host, async () => {
			try {
				return await fetchImpl(url, { ...init, headers: { ...init.headers, "user-agent": USER_AGENT }, redirect: "manual", credentials: "omit", signal: AbortSignal.timeout(timeoutMs) });
			} catch (error) {
				throw new FetchProblem(error?.name === "TimeoutError" || error?.name === "AbortError" ? "took too long to answer" : "the server could not be reached");
			}
		});
	}

	// robots.txt, through up to five redirects as RFC 9309 asks, each hop held to the same address rules. A hop that breaks them
	// counts as unreachable, which disallows the host for an hour (lib/briefings/robots.js).
	async function loadRobots(robotsUrl) {
		let url = robotsUrl;
		for (let hops = 0; hops <= ROBOTS_REDIRECTS; hops += 1) {
			const problem = getFeedUrlProblem(url);
			if (problem) throw new FetchProblem(problem);
			await assertPublic(new URL(url));
			const response = await send(url, { headers: { accept: "text/plain" } }, FETCH_LIMITS.timeoutMs);
			const location = response.headers.get("location");
			if (response.status >= 300 && response.status < 400 && location) {
				await response.body?.cancel();
				url = new URL(location, url).href;
				continue;
			}
			if (response.status < 200 || response.status >= 300) {
				await response.body?.cancel();
				return { status: response.status, text: "" };
			}
			let text;
			try {
				text = await readBody(response, ROBOTS.bytes);
			} catch {
				text = "";
			}
			return { status: response.status, text };
		}
		throw new FetchProblem("robots.txt redirects too many times");
	}

	// Whether robots.txt lets the briefings fetcher open the address. Also asked before a provider fetches a page for us.
	async function allowedByRobots(link) {
		const url = new URL(link);
		const rules = await getRobotsRules(url.href, loadRobots, now());
		return isAllowed(rules, `${url.pathname}${url.search}`);
	}

	async function checkAddress(link, { hops, rule }) {
		const problem = rule(link);
		if (problem) throw new FetchProblem(hops === 0 ? problem : `redirects to an address FlockStack can't read: ${problem}`, { final: true });
		const url = new URL(link);
		await assertPublic(url);
		if (!(await allowedByRobots(url.href))) throw new FetchProblem("robots.txt asks FlockStack not to read it", { final: true, robots: true });
	}

	// { url (final), status, text, contentType } of a page.
	async function get(link, { accept = "text/html,application/xhtml+xml,*/*;q=0.8" } = {}) {
		let url = link;
		for (let hops = 0; hops <= FETCH_LIMITS.redirects; hops += 1) {
			await checkAddress(url, { hops, rule: getFeedUrlProblem });
			const response = await send(url, { headers: { accept } }, FETCH_LIMITS.timeoutMs);
			const location = response.headers.get("location");
			if (response.status >= 300 && response.status < 400 && location) {
				await response.body?.cancel();
				try {
					url = new URL(location, url).href;
				} catch {
					throw new FetchProblem("redirects to a bad address");
				}
				continue;
			}
			if (response.status !== 200) {
				await response.body?.cancel();
				throw new FetchProblem(`answered ${response.status}`, { status: response.status, final: FINAL_STATUSES.has(response.status) });
			}
			return { url, status: 200, text: await readBody(response, FETCH_LIMITS.bytes), contentType: response.headers.get("content-type") ?? "" };
		}
		throw new FetchProblem("redirects too many times");
	}

	// A link in a draft, judged as the ready-to-send check judges one (lib/link-check.js): head first, then the first byte.
	async function checkLink(link) {
		let url = link;
		let method = "HEAD";
		for (let hops = 0; hops <= LINK_CHECK.redirects; ) {
			try {
				await checkAddress(url, { hops, rule: (value) => (getLinkProblem(value) ? `the address ${getLinkProblem(value)}` : null) });
			} catch (error) {
				if (error.robots) return { url: link, state: "unsure", reason: "robots.txt asks FlockStack not to open it" };
				return { url: link, state: "broken", reason: error.message.replace(/^the address /, "") };
			}
			let response;
			try {
				response = await send(url, { method, headers: { accept: "text/html,*/*;q=0.8", ...(method === "GET" && { range: "bytes=0-0" }) } }, LINK_CHECK.timeoutMs);
			} catch (error) {
				if (/reached its/.test(error.message)) return { url: link, state: "unsure", reason: "not checked: the run reached its fetch cap" };
				return { url: link, state: /too long/.test(error.message) ? "unsure" : "broken", reason: error.message };
			}
			await response.body?.cancel();
			const location = response.headers.get("location");
			if (response.status >= 300 && response.status < 400 && location) {
				try {
					url = new URL(location, url).href;
				} catch {
					return { url: link, state: "broken", reason: "redirects to a bad address" };
				}
				hops += 1;
				continue;
			}
			if (method === "HEAD" && response.status >= 400 && !FINAL_STATUSES.has(response.status) && response.status !== 404 && response.status !== 410) {
				method = "GET";
				continue;
			}
			return { url: link, ...judgeStatus(response.status) };
		}
		return { url: link, state: "broken", reason: "redirects too many times" };
	}

	// A discovery provider's own API (GDELT, Algolia, TinyFish, a candidate feed): https to a public host, our user agent, the
	// same time and size caps, no redirects followed. Not counted against the run's page fetches, and not held to robots.txt,
	// which governs crawling pages, not a documented API. Answers { status, headers, text }.
	async function api(link, init = {}) {
		const url = new URL(link);
		const problem = getFeedUrlProblem(url.href);
		if (problem) throw new FetchProblem(problem, { final: true });
		await assertPublic(url);
		const response = await send(url.href, { method: init.method ?? "GET", headers: init.headers ?? {}, ...(init.body !== undefined && { body: init.body }) }, init.timeoutMs ?? FETCH_LIMITS.timeoutMs, { counted: false });
		if (response.status >= 300 && response.status < 400) {
			await response.body?.cancel();
			throw new FetchProblem(`answered ${response.status}`, { status: response.status });
		}
		return { status: response.status, headers: response.headers, text: await readBody(response, init.bytes ?? FETCH_LIMITS.bytes) };
	}

	return {
		get,
		checkLink,
		api,
		assertPublic,
		allowedByRobots,
		isBlocked: (link) => {
			try {
				return isBlockedHost(new URL(link), blockedHosts);
			} catch {
				return true;
			}
		},
		get count() {
			return count;
		},
	};
}

// Runs task over items, `limit` at a time, in order of the items.
export async function mapLimited(items, limit, task) {
	const results = new Array(items.length);
	let next = 0;
	async function worker() {
		while (next < items.length) {
			const index = next++;
			results[index] = await task(items[index], index);
		}
	}
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return results;
}
