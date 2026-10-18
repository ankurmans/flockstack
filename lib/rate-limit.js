import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
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

function getLimiter({ name, limit, window }) {
	const { UPSTASH_REDIS_REST_URL: url, UPSTASH_REDIS_REST_TOKEN: token } = process.env;
	if (!url || !token) return null;
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

export function isLimitedInMemory({ name, limit, window, key }, now = Date.now()) {
	const id = `${name}:${key}`;
	const hits = (memory.get(id) ?? []).filter((time) => now - time < windowMs(window));
	const isLimited = hits.length >= limit;
	if (!isLimited) hits.push(now);
	// Re-inserting keeps the Map in order of last use, so the oldest key goes first when it's full.
	memory.delete(id);
	memory.set(id, hits);
	if (memory.size > MAX_MEMORY_KEYS) memory.delete(memory.keys().next().value);
	return isLimited;
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
export async function isLimitedInDatabase({ name, limit, window, key }, now = Date.now()) {
	const size = windowMs(window);
	const index = Math.floor(now / size);
	const current = `${name}:${key}:${index}`;
	const previous = `${name}:${key}:${index - 1}`;
	await connectDb();
	const windows = await RateLimit.find({ key: { $in: [current, previous] } }).lean();
	const hits = (id) => windows.find((item) => item.key === id)?.count ?? 0;
	const overlap = 1 - (now % size) / size;
	if (hits(previous) * overlap + hits(current) >= limit) return true;
	await RateLimit.updateOne({ key: current }, { $inc: { count: 1 }, $setOnInsert: { expiresAt: new Date((index + 2) * size) } }, { upsert: true });
	if (Math.random() < CLEANUP_ODDS) await RateLimit.deleteMany({ expiresAt: { $lt: new Date(now) } });
	return false;
}

export async function isRateLimited({ name, limit, window, key, store }, limiter = getLimiter({ name, limit, window })) {
	if (store === "memory") return isLimitedInMemory({ name, limit, window, key });
	if (!limiter) {
		try {
			return await isLimitedInDatabase({ name, limit, window, key });
		} catch (error) {
			await reportUnavailable(name, error, "The database");
			return isLimitedInMemory({ name, limit, window, key });
		}
	}
	try {
		const { success, reason } = await limiter.limit(key);
		// Upstash lets a request through when Redis doesn't answer in time.
		if (reason === "timeout") throw Object.assign(new Error("Redis timed out"), { isTimeout: true });
		return !success;
	} catch (error) {
		await reportUnavailable(name, error, "Upstash Redis");
		return isLimitedInMemory({ name, limit, window, key });
	}
}
