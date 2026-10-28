import { getFeedUrlProblem } from "../feed-url.js";
import { LINK_CHECK, getLinkProblem, judgeStatus } from "../link-check-rules.js";
import { ROBOTS, getRobotsRules, isAllowed } from "./robots.js";

// How the briefings engine opens the pages of the stories it picked and checks the links of a draft. The rules are the feed
// fetcher's (lib/feed-fetch.js FEED_LIMITS: https to a public host, 1 MB, 8 s, three redirects each checked like the first
// address), kept here rather than imported so the engine's Worker doesn't load the feed cache and the app's account helpers;
// tests/briefings-engine-units.test.mjs keeps the two equal. On top of them: robots.txt, two requests at a time to one host
// and a cap on the fetches of one run.
export const FETCH_LIMITS = { bytes: 1_000_000, timeoutMs: 8000, redirects: 3, perHost: 2, perRun: 300 };
export const USER_AGENT = "FlockStack (+https://flockstack.io)";

export class FetchProblem extends Error {
	constructor(message) {
		super(message);
		this.name = "FetchProblem";
	}
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

// A run's fetcher. used: the fetches the run made in earlier ticks, so the cap is per run, not per tick.
export function createFetcher({ fetchImpl = globalThis.fetch, used = 0, perRun = FETCH_LIMITS.perRun, now = () => Date.now() } = {}) {
	let count = used;
	const active = new Map();
	const waiting = new Map();

	async function withHost(host, task) {
		while ((active.get(host) ?? 0) >= FETCH_LIMITS.perHost) {
			await new Promise((resolve) => waiting.set(host, [...(waiting.get(host) ?? []), resolve]));
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

	async function request(url, init, timeoutMs) {
		if (count >= perRun) throw new FetchProblem(`the run reached its ${perRun} fetches`);
		count += 1;
		const host = new URL(url).host;
		return withHost(host, async () => {
			try {
				return await fetchImpl(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
			} catch (error) {
				throw new FetchProblem(error?.name === "TimeoutError" || error?.name === "AbortError" ? "took too long to answer" : "the server could not be reached");
			}
		});
	}

	async function loadRobots(robotsUrl) {
		const response = await request(robotsUrl, { headers: { accept: "text/plain", "user-agent": USER_AGENT } }, FETCH_LIMITS.timeoutMs);
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

	async function allowedByRobots(url) {
		const rules = await getRobotsRules(url, loadRobots, now());
		const { pathname, search } = new URL(url);
		return isAllowed(rules, `${pathname}${search}`);
	}

	// { url (final), status, text, contentType } of a source or page. Each address along the way passes the feed rule and
	// robots.txt; anything but a 200 is a problem.
	async function get(link, { accept = "text/html,application/xhtml+xml,*/*;q=0.8" } = {}) {
		let url = link;
		for (let hops = 0; hops <= FETCH_LIMITS.redirects; hops += 1) {
			const problem = getFeedUrlProblem(url);
			if (problem) throw new FetchProblem(hops === 0 ? problem : `redirects to an address FlockStack can't read: ${problem}`);
			if (!(await allowedByRobots(url))) throw new FetchProblem("robots.txt asks FlockStack not to read it");
			const response = await request(url, { headers: { accept, "user-agent": USER_AGENT } }, FETCH_LIMITS.timeoutMs);
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
				throw new FetchProblem(`answered ${response.status}`);
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
			const problem = getLinkProblem(url);
			if (problem) return { url: link, state: "broken", reason: hops === 0 ? problem : `redirects to an address that ${problem}` };
			let response;
			try {
				response = await request(url, { method, headers: { "user-agent": USER_AGENT, accept: "text/html,*/*;q=0.8", ...(method === "GET" && { range: "bytes=0-0" }) } }, LINK_CHECK.timeoutMs);
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
			if (method === "HEAD" && response.status >= 400 && response.status !== 404 && response.status !== 410) {
				method = "GET";
				continue;
			}
			return { url: link, ...judgeStatus(response.status) };
		}
		return { url: link, state: "broken", reason: "redirects too many times" };
	}

	return {
		get,
		checkLink,
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
