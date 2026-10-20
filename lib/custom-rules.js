import { isDisposableDomain } from "./disposable-domains.js";
import {
	CUSTOM_EMAIL_RANGES,
	CUSTOM_LIMITS,
	CUSTOM_NEEDS,
	CUSTOM_PLATFORMS,
	CUSTOM_STATUSES,
	CUSTOM_SUBSCRIBER_RANGES,
	CUSTOM_TIMELINES,
	choiceIds,
} from "./custom-choices.js";
import { normalizeEmail } from "./validation.js";

const text = (value, max) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);

// Notes and messages keep their line breaks, with no more than one empty line in a row.
const paragraphs = (value, max) =>
	String(value ?? "")
		.replace(/\r\n?/g, "\n")
		.replace(/[^\S\n]+/g, " ")
		.replace(/\n{3,}/g, "\n\n")
		.trim()
		.slice(0, max);

// A site or a bare domain, as people type it: stored as an http(s) address, or refused.
export function normalizeWebsite(value) {
	const raw = text(value, CUSTOM_LIMITS.website);
	if (!raw) return { value: "" };
	const address = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
	const problem = { problem: "Enter your website as an address like example.com" };
	if (!URL.canParse(address)) return problem;
	const url = new URL(address);
	if (!["http:", "https:"].includes(url.protocol) || !url.hostname.includes(".") || url.username || url.password) return problem;
	return { value: `${url.protocol}//${url.host}${url.pathname === "/" ? "" : url.pathname}`.slice(0, CUSTOM_LIMITS.website) };
}

function pick(value, choices) {
	const id = String(value ?? "").trim();
	return choiceIds(choices).includes(id) ? id : "";
}

// A request form's fields, read by get(name) and getAll(name), to what is stored, or the first problem to show. The
// honeypot is the caller's business: it answers before anything is read.
export function parseCustomRequest({ get, getAll }) {
	const name = text(get("name"), CUSTOM_LIMITS.name);
	if (!name) return { problem: "Enter your name" };

	const email = normalizeEmail(get("email"));
	if (!email) return { problem: "Enter a valid email" };
	if (isDisposableDomain(email.split("@")[1])) return { problem: "Use your work email: we reply to it" };

	const company = text(get("company"), CUSTOM_LIMITS.company);
	if (!company) return { problem: "Tell us your newsletter or company" };

	const website = normalizeWebsite(get("website"));
	if (website.problem) return { problem: website.problem };

	const ticked = getAll("needs").map(String);
	const needs = choiceIds(CUSTOM_NEEDS).filter((id) => ticked.includes(id));

	return {
		value: {
			name,
			email,
			company,
			website: website.value,
			platform: pick(get("platform"), CUSTOM_PLATFORMS),
			subscribers: pick(get("subscribers"), CUSTOM_SUBSCRIBER_RANGES),
			emailsPerMonth: pick(get("emailsPerMonth"), CUSTOM_EMAIL_RANGES),
			needs,
			otherNeed: needs.includes("other") ? text(get("otherNeed"), CUSTOM_LIMITS.otherNeed) : "",
			timeline: pick(get("timeline"), CUSTOM_TIMELINES),
			message: paragraphs(get("message"), CUSTOM_LIMITS.message),
		},
	};
}

export function readStatus(value) {
	return pick(value, CUSTOM_STATUSES);
}

export function readNotes(value) {
	return paragraphs(value, CUSTOM_LIMITS.notes);
}

// The admin's counts: for each thing people could need, how many requests ticked it; requests per month (YYYY-MM in UTC,
// oldest first) and per subscriber range. A choice nobody picked counts 0, so the page shows every one.
export function tallyCustomRequests(requests) {
	const needs = Object.fromEntries(choiceIds(CUSTOM_NEEDS).map((id) => [id, 0]));
	const subscribers = Object.fromEntries([...choiceIds(CUSTOM_SUBSCRIBER_RANGES), "unknown"].map((id) => [id, 0]));
	const months = new Map();
	for (const request of requests) {
		for (const id of new Set(request.needs ?? [])) if (Object.hasOwn(needs, id)) needs[id]++;
		subscribers[request.subscribers && Object.hasOwn(subscribers, request.subscribers) ? request.subscribers : "unknown"]++;
		const month = new Date(request.createdAt).toISOString().slice(0, 7);
		months.set(month, (months.get(month) ?? 0) + 1);
	}
	return {
		total: requests.length,
		needs: CUSTOM_NEEDS.map(({ id, label }) => ({ id, label, count: needs[id] })).sort((a, b) => b.count - a.count),
		subscribers: [...CUSTOM_SUBSCRIBER_RANGES, { id: "unknown", label: "Not said" }].map(({ id, label }) => ({ id, label, count: subscribers[id] })),
		months: [...months].sort(([a], [b]) => a.localeCompare(b)).map(([month, count]) => ({ month, count })),
	};
}
