import { connectDb } from "@/lib/db";
import RateLimit from "@/models/RateLimit";

const limiters = new Map();
let redis;

// Without Redis the limits are counted in the database, so every server instance shares them. While the store
// is down, or for a limit that asks for store: "memory" (one that would write on every page view), they're counted
// in this server instance's memory: instances don't share it and lose it on restart, so it's weaker on serverless
// hosts, but a script hammering one form still gets stopped.
const memory = new Map();
const MAX_MEMORY_KEYS = 10_000;
const UNIT_MS = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
const REPORT_EVERY_MINUTES = 30;
let lastReportAt = 0;

// The Upstash libraries (300 KB) load with the first limit that has Redis to ask, not with this module, which every sign-in loads.
async function getLimiter({ name, limit, window }) {
	const { UPSTASH_REDIS_REST_URL: url, UPSTASH_REDIS_REST_TOKEN: token } = process.env;
	if (!url || !token) return null;
	const [{ Ratelimit }, { Redis }] = await Promise.all([import("@upstash/ratelimit"), import("@upstash/redis")]);
	redis ??= new Redis({ url, token });
	if (!limiters.has(name)) {
		limiters.set(
			name,
			new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(limit, window), prefix: `flockstack/${name}` })
		);
	}
	return limiters.get(name);
}

// Windows use Upstash's format: "10 m", "1 h".
function windowMs(window) {
	const [amount, unit] = String(window).trim().split(/\s+/);
	return Number(amount) * (UNIT_MS[unit] ?? Number.NaN);
}

// { limited, remaining }: remaining is what is left in the window after this request.
function countInMemory({ name, limit, window, key }, now = Date.now()) {
	const id = `${name}:${key}`;
	const hits = (memory.get(id) ?? []).filter((time) => now - time < windowMs(window));
	const limited = hits.length >= limit;
	if (!limited) hits.push(now);
	// Re-inserting keeps the Map in order of last use, so the oldest key goes first when it's full.
	memory.delete(id);
	memory.set(id, hits);
	if (memory.size > MAX_MEMORY_KEYS) memory.delete(memory.keys().next().value);
	return { limited, remaining: Math.max(0, limit - hits.length) };
}

export function isLimitedInMemory(options, now = Date.now()) {
	return countInMemory(options, now).limited;
}

// Logged at most every 30 minutes per server instance, so an outage doesn't write a line for every request. Errors
// other than a timeout, which Redis gets over on its own, alert the admins after the response.
async function reportUnavailable(name, error, store) {
	if (Date.now() - lastReportAt < REPORT_EVERY_MINUTES * 60_000) return;
	lastReportAt = Date.now();
	console.error(`[rate-limit] ${name} unavailable, counting in memory:`, error.message);
	if (error.isTimeout) return;
	try {
		// Loaded on demand: alerts need Next.js and the database, which counting doesn't.
		const [{ after }, { sendAlert }] = await Promise.all([import("next/server"), import("./alerts.js")]);
		after(() =>
			sendAlert({
				key: "rate-limit-unavailable",
				title: "Rate limiter unavailable",
				detail: `${store} failed (${error.message}). Limits are counted in each server instance's memory until it's back.`,
				action: store === "Upstash Redis" ? "Check the database and its token in Upstash's console." : "Check the D1 database in Cloudflare's dashboard.",
				...(store === "Upstash Redis" && { link: "https://console.upstash.com/redis" }),
				cooldownMinutes: REPORT_EVERY_MINUTES,
			})
		);
	} catch (alertError) {
		console.error("[rate-limit] Alert failed:", alertError.message);
	}
}

export function getClientIp(headers) {
	const forwardedFor = headers.get("x-forwarded-for")?.split(",")[0].trim();
	return forwardedFor || headers.get("x-real-ip") || "unknown";
}

const CLEANUP_ODDS = 0.01;

// A sliding window counted from two fixed ones: the current window's hits plus the previous window's, weighted by how
// much of it still overlaps. A check that lets a hit through counts it; one that refuses doesn't.
async function countInDatabase({ name, limit, window, key }, now = Date.now()) {
	const size = windowMs(window);
	const index = Math.floor(now / size);
	const current = `${name}:${key}:${index}`;
	const previous = `${name}:${key}:${index - 1}`;
	await connectDb();
	const windows = await RateLimit.find({ key: { $in: [current, previous] } }).lean();
	const hits = (id) => windows.find((item) => item.key === id)?.count ?? 0;
	const overlap = 1 - (now % size) / size;
	const used = hits(previous) * overlap + hits(current);
	if (used >= limit) return { limited: true, remaining: 0 };
	await RateLimit.updateOne({ key: current }, { $inc: { count: 1 }, $setOnInsert: { expiresAt: new Date((index + 2) * size) } }, { upsert: true });
	if (Math.random() < CLEANUP_ODDS) await RateLimit.deleteMany({ expiresAt: { $lt: new Date(now) } });
	return { limited: false, remaining: Math.max(0, Math.floor(limit - used - 1)) };
}

export async function isLimitedInDatabase(options, now = Date.now()) {
	return (await countInDatabase(options, now)).limited;
}

export async function isRateLimited(options, limiter) {
	return (await checkRateLimit(options, limiter)).limited;
}

// { limited, remaining }: whether this request is over the limit, and how many more the window takes after it, for the
// RateLimit headers of the API.
export async function checkRateLimit({ name, limit, window, key, store }, limiter) {
	if (store === "memory") return countInMemory({ name, limit, window, key });
	limiter ??= await getLimiter({ name, limit, window });
	if (!limiter) {
		try {
			return await countInDatabase({ name, limit, window, key });
		} catch (error) {
			await reportUnavailable(name, error, "The database");
			return countInMemory({ name, limit, window, key });
		}
	}
	try {
		const { success, reason, remaining } = await limiter.limit(key);
		// Upstash lets a request through when Redis doesn't answer in time.
		if (reason === "timeout") throw Object.assign(new Error("Redis timed out"), { isTimeout: true });
		return { limited: !success, remaining: Math.max(0, remaining ?? 0) };
	} catch (error) {
		await reportUnavailable(name, error, "Upstash Redis");
		return countInMemory({ name, limit, window, key });
	}
}

// The window in whole seconds, for the headers.
export function getWindowSeconds(window) {
	return Math.round(windowMs(window) / 1000);
}
