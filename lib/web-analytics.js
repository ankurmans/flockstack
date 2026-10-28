import "server-only";
import crypto from "node:crypto";
import { scoped } from "@/lib/account-scope";
import { toReferrerHost } from "@/lib/attribution";
import { getNewsletterHost } from "@/lib/archive-hosts";
import { getAppHost, getAppSecret } from "@/lib/config";
import { getDayKey } from "@/lib/forms";
import { getHeaderCountry } from "@/lib/signup-country";
import { PUBLISHED_STATUSES } from "@/lib/archive-issues";
import { shiftDateKey } from "@/lib/time-zone";
import Campaign from "@/models/Campaign";
import WebDay from "@/models/WebDay";

// Visits to a newsletter's website, counted without a cookie, a stored address or anything a visitor carries between pages.
// A page's beacon (components/TrackVisit.jsx) says which page; the server adds the country Cloudflare saw and a hash of the
// network address and browser. That hash is made with a key that changes every UTC day, is never stored, and only decides
// which register of the day's sketch of distinct visitors to raise: a visitor on another day, or on another newsletter, is a
// different one. Do Not Track and Global Privacy Control are honored. Counts are one row for each newsletter and day.
export const VISIT_PER_VISITOR = { name: "web-visits", limit: 90, window: "10 m", store: "memory" };
export const VISIT_KINDS = ["home", "issue", "other"];
export const DEVICE_CLASSES = ["desktop", "mobile", "tablet"];
const REGISTER_BITS = 8;
const REGISTERS = 2 ** REGISTER_BITS;
const MAX_REFERRERS_PER_DAY = 100;
const OTHER = "other";
const DIRECT = "direct";
const UNKNOWN_COUNTRY = "XX";

// A visitor who asks not to be measured, by either signal browsers send.
export function isOptedOut(headers) {
	return headers.get("dnt") === "1" || headers.get("sec-gpc") === "1";
}

// desktop, mobile or tablet from the browser's user agent (and its mobile hint, which Chromium browsers send), and nothing else of
// it: only the class is counted, never the user agent. An iPad that asks for desktop sites says so and counts as a desktop.
export function getDeviceClass(userAgent, mobileHint = "") {
	const agent = String(userAgent ?? "");
	if (/ipad|tablet|kindle|silk\/|playbook|nexus (7|9|10)|sm-t\d|(android)(?!.*mobile)/i.test(agent)) return "tablet";
	if (/mobi|iphone|ipod|windows phone|blackberry|opera mini/i.test(agent) || String(mobileHint).trim() === "?1") return "mobile";
	return "desktop";
}

// The same two letters the signup keeps (lib/signup-country.js), or XX for a visit whose country Cloudflare doesn't know.
export function getCountry(headers) {
	return getHeaderCountry(headers) ?? UNKNOWN_COUNTRY;
}

export const encodeKey = (value) => value.replaceAll(".", ",");
export const decodeKey = (value) => value.replaceAll(",", ".");

// Which register a visitor raises, and to what: the hash's first bits pick the register and the rest give the rank, the
// position of its first 1. The key for the hash is the app's secret and the day.
export function getVisitorRegister({ ip, userAgent, newsletterId, day }) {
	const key = crypto.hkdfSync("sha256", getAppSecret(), "", `flockstack-web-visitor-v1:${day}`, 32);
	const digest = crypto.createHmac("sha256", Buffer.from(key)).update(`${newsletterId}|${ip}|${userAgent}`).digest();
	const bits = digest.readUInt32BE(0);
	const index = bits >>> (32 - REGISTER_BITS);
	const rest = (bits << REGISTER_BITS) >>> 0;
	return { index, rank: Math.min(Math.clz32(rest) + 1, 32 - REGISTER_BITS + 1) };
}

// HyperLogLog's estimate of how many distinct visitors raised these registers ({ r<index>: rank }): within about 7% at any
// size, and exact enough for the few a small newsletter has.
export function estimateVisitors(registers = {}) {
	let sum = REGISTERS - Object.keys(registers).length;
	for (const rank of Object.values(registers)) sum += 2 ** -rank;
	const zeros = REGISTERS - Object.keys(registers).length;
	const estimate = (0.7213 / (1 + 1.079 / REGISTERS)) * REGISTERS * (REGISTERS / sum);
	return Math.round(zeros > 0 && estimate <= 2.5 * REGISTERS ? REGISTERS * Math.log(REGISTERS / zeros) : estimate);
}

// A minute's memory of which slug is a newsletter with its website on.
const CACHE_MS = 60_000;
const known = new Map();

export async function findVisitedNewsletter(slug) {
	const hit = known.get(slug);
	if (hit && hit.until > Date.now()) return hit.newsletter;
	const { default: Newsletter } = await import("@/models/Newsletter");
	const newsletter = await Newsletter.findOne({ slug, archiveEnabled: true }).setOptions({ crossAccount: true }).select({ accountId: 1, slug: 1, archiveHost: 1, mount: 1 }).lean();
	if (known.size > 2000) known.clear();
	known.set(slug, { newsletter, until: Date.now() + CACHE_MS });
	return newsletter;
}

// One visit. kind and post say which page; a post that isn't a published issue of the newsletter counts as another page.
export async function countVisit({ newsletter, kind, post, referrer, country, ip, userAgent, mobileHint = "", now = new Date() }) {
	const day = getDayKey(now);
	const filter = scoped(newsletter.accountId, { newsletterId: newsletter._id, day });
	const host = toReferrerHost(referrer, [getNewsletterHost(newsletter), getAppHost()]);
	const isIssue = kind === "issue" && post ? Boolean(await Campaign.exists({ accountId: newsletter.accountId, newsletterId: newsletter._id, archiveSlug: post, status: { $in: PUBLISHED_STATUSES } })) : false;

	// A forged referrer costs one more key a day, up to a limit: past it, the rest are counted together.
	let referrerKey = host ? encodeKey(host) : DIRECT;
	if (host) {
		const current = await WebDay.findOne(filter).select({ referrers: 1 }).lean();
		const keys = Object.keys(current?.referrers ?? {});
		if (keys.length >= MAX_REFERRERS_PER_DAY && !keys.includes(referrerKey)) referrerKey = OTHER;
	}
	const device = getDeviceClass(userAgent, mobileHint);
	const { index, rank } = getVisitorRegister({ ip, userAgent, newsletterId: newsletter._id, day });
	await WebDay.updateOne(
		filter,
		{
			$inc: { views: 1, [`countries.${country}`]: 1, [`devices.${device}`]: 1, [`referrers.${referrerKey}`]: 1, ...(isIssue && { [`pages.${post}`]: 1 }) },
			// "r17", not "17": a path of digits makes the database an array.
			$max: { [`hll.r${index}`]: rank },
		},
		{ upsert: true }
	);
}

function addCounts(target, source = {}) {
	for (const [key, count] of Object.entries(source)) target.set(key, (target.get(key) ?? 0) + count);
}

const TOP = 20;
const topOf = (counts, name) =>
	[...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, TOP).map(([key, views]) => ({ [name]: key, views }));

// What a newsletter's website did over `days`: views and distinct visitors for each day, and where they came from, what
// country, and which issues. Visitors are counted for each day: someone back the next day is another visitor, so the total
// is the days' sum, and says so.
export async function getSiteReport({ account, newsletter, days = 30, now = new Date() }) {
	const today = getDayKey(now);
	const from = shiftDateKey(today, -days + 1);
	const rows = await WebDay.find(scoped(account, { newsletterId: newsletter._id, day: { $gte: from, $lte: today } })).lean();
	const byDay = new Map(rows.map((row) => [row.day, row]));
	const daily = Array.from({ length: days }, (_, index) => {
		const date = shiftDateKey(from, index);
		const row = byDay.get(date);
		return { date, views: row?.views ?? 0, visitors: row ? estimateVisitors(row.hll) : 0 };
	});
	const [pages, referrers, countries, devices] = [new Map(), new Map(), new Map(), new Map()];
	for (const row of rows) {
		addCounts(devices, row.devices);
		addCounts(pages, row.pages);
		addCounts(referrers, row.referrers);
		addCounts(countries, row.countries);
	}
	const titles = pages.size > 0 ? await Campaign.find(scoped(account, { newsletterId: newsletter._id, archiveSlug: { $in: [...pages.keys()].slice(0, 90) } })).select({ archiveSlug: 1, subject: 1 }).lean() : [];
	const subjectOf = new Map(titles.map(({ archiveSlug, subject }) => [archiveSlug, subject]));
	const names = new Intl.DisplayNames(["en"], { type: "region" });
	const labelOf = (code) => (code === UNKNOWN_COUNTRY ? "Unknown" : (names.of(code) ?? code));
	return {
		from,
		to: today,
		days,
		daily,
		totals: { views: daily.reduce((sum, day) => sum + day.views, 0), visitors: daily.reduce((sum, day) => sum + day.visitors, 0) },
		referrers: topOf(referrers, "referrer").map(({ referrer, views }) => ({ referrer: referrer === DIRECT ? "Direct or unknown" : referrer === OTHER ? "Other sites" : decodeKey(referrer), views })),
		countries: topOf(countries, "country").map(({ country, views }) => ({ country: labelOf(country), code: country, views })),
		// Visits from before the split was counted have no device, so these can add up to less than the views.
		devices: DEVICE_CLASSES.map((device) => ({ device, views: devices.get(device) ?? 0 })),
		pages: topOf(pages, "slug").map(({ slug, views }) => ({ slug, title: subjectOf.get(slug) ?? slug, views })),
	};
}
