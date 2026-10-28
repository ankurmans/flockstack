// robots.txt as the briefings engine reads it: the group for its product token (FlockStack-Briefings, or the FlockStack family's
// own group), else the one for every agent, and the
// longest matching Allow or Disallow rule wins (RFC 9309). Kept per host for a day in the isolate's memory: a Worker isolate
// lives for many ticks, and a host read again after a restart costs one small fetch.
export const ROBOTS = { bytes: 100_000, keepMs: 24 * 60 * 60_000, keepFailedMs: 60 * 60_000, agents: ["flockstack-briefings", "flockstack"] };

const cache = new Map();

export function clearRobotsCache() {
	cache.clear();
}

export function parseRobots(text) {
	const groups = [];
	let current = null;
	let lastWasAgent = false;
	for (const raw of String(text ?? "").split(/\r?\n/)) {
		const line = raw.replace(/#.*$/, "").trim();
		const match = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line);
		if (!match) continue;
		const field = match[1].toLowerCase();
		const value = match[2].trim();
		if (field === "user-agent") {
			if (!lastWasAgent || !current) {
				current = { agents: [], rules: [] };
				groups.push(current);
			}
			current.agents.push(value.toLowerCase());
			lastWasAgent = true;
			continue;
		}
		lastWasAgent = false;
		if (!current || (field !== "allow" && field !== "disallow")) continue;
		current.rules.push({ allow: field === "allow", path: value });
	}
	const named = (token) => groups.filter(({ agents }) => agents.some((agent) => agent.replace(/\/.*$/, "") === token));
	const own = ROBOTS.agents.map(named).find((found) => found.length) ?? [];
	const chosen = own.length ? own : groups.filter(({ agents }) => agents.includes("*"));
	return chosen.flatMap(({ rules }) => rules).filter(({ path }) => path !== "");
}

function patternMatches(pattern, path) {
	const anchored = pattern.endsWith("$");
	const body = anchored ? pattern.slice(0, -1) : pattern;
	const source = body
		.split("*")
		.map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
		.join(".*");
	return new RegExp(`^${source}${anchored ? "$" : ""}`).test(path);
}

// Whether the rules let FlockStack open the path (with its query).
export function isAllowed(rules, path) {
	let best = null;
	for (const rule of rules) {
		if (!patternMatches(rule.path, path)) continue;
		if (!best || rule.path.length > best.path.length || (rule.path.length === best.path.length && rule.allow)) best = rule;
	}
	return !best || best.allow;
}

// The rules for a URL's host, from the cache or read with `load(robotsUrl)` -> { status, text } (throws when unreachable).
// No file (4xx) allows everything; a server error or no answer disallows the host for an hour, as RFC 9309 asks.
export async function getRobotsRules(url, load, now = Date.now()) {
	const { origin } = new URL(url);
	const kept = cache.get(origin);
	if (kept && now - kept.at < kept.keepMs) return kept.rules;
	// Pages of one host asked for at once wait for the same read of its file.
	const reading = (async () => {
		try {
			const { status, text } = await load(`${origin}/robots.txt`);
			if (status >= 200 && status < 300) return { rules: parseRobots(text.slice(0, ROBOTS.bytes)), keepMs: ROBOTS.keepMs };
			if (status >= 400 && status < 500) return { rules: [], keepMs: ROBOTS.keepMs };
		} catch {
			// Unreachable counts as a server error.
		}
		return { rules: [{ allow: false, path: "/" }], keepMs: ROBOTS.keepFailedMs };
	})();
	const entry = { rules: reading.then(({ rules }) => rules), at: now, keepMs: ROBOTS.keepMs };
	cache.set(origin, entry);
	const { rules, keepMs } = await reading;
	entry.keepMs = keepMs;
	return rules;
}
