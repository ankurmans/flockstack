import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { addIssue, addReader, createPublisher, importModels, inBrowser, signInReader } from "./helpers/community.mjs";
import { anonymous, callApi, jsonRequest, startTestApp } from "./helpers/app.mjs";
import { childOf, childrenOf, parseXml } from "./helpers/xml.mjs";
import { requests, resetVoice } from "./stubs/elevenlabs.mjs";
import { published } from "./stubs/qstash.mjs";

// Audio next to the rest of the release: the Free plan has none, a paid issue's audio goes by tier, a gated issue's audio
// opens for signed-in subscribers, and the AI allowance and the audio characters are two counters.

const VOICES = [{ id: "21m00Tcm4TlvDq8ikWAM", name: "Rachel", description: "Calm and clear", previewUrl: "https://example.com/rachel.mp3" }];
const SHARED_DOMAIN = "flockstackmail.com";
const DAY = 86_400_000;

let app;
let m;
let counter = 0;
let processed = 0;

before(async () => {
	app = await startTestApp({
		EXPORT_STORAGE: "memory",
		QSTASH_CURRENT_SIGNING_KEY: "sig-current",
		QSTASH_NEXT_SIGNING_KEY: "sig-next",
		ELEVENLABS_API_KEY: "xi-test-key",
		ELEVENLABS_VOICES: JSON.stringify(VOICES),
		AUDIO_ENABLED: "true",
		ELEVENLABS_NOTICE_SENT_ON_TEST: "2026-01-01",
	});
	m = {
		...(await importModels()),
		jobRoute: await import("../app/api/jobs/make-audio/route.js"),
		audioRoute: await import("../app/archive/[slug]/audio/[post]/route.js"),
		podcastRoute: await import("../app/archive/[slug]/podcast/route.js"),
		events: await import("../lib/webhook-events.js"),
		plans: await import("../lib/plans.js"),
		subprocessors: await import("../lib/subprocessors.js"),
		Account: (await import("../models/Account.js")).default,
		AiUsage: (await import("../models/AiUsage.js")).default,
		AudioUsage: (await import("../models/AudioUsage.js")).default,
	};
	processed = published.length;
});

after(() => app?.stop());
beforeEach(() => resetVoice());

const paragraphs = (count) => Array.from({ length: count }, (_, index) => `<p>${Array.from({ length: 14 }, (__, i) => `Sentence number ${index * 14 + i} is here to be read aloud by the voice.`).join(" ")}</p>`).join("");
const api = (user, method, path, body) => callApi(method, `/api/v1${path}`, { key: user.key, body });
const idOf = (issue) => String(issue._id);

async function runJobs() {
	while (processed < published.length) {
		const job = published[processed++];
		if (!job.url.endsWith("/api/jobs/make-audio")) continue;
		const response = await m.jobRoute.POST(jsonRequest(job.url, { method: "POST", body: job.body }));
		assert.ok(response.status < 400, await response.text());
	}
}

const publisher = () => createPublisher(m, `access${++counter}@example.com`, { issue: { subject: "Open issue", html: paragraphs(2) } });

async function audioFor(user, issue) {
	const created = await api(user, "POST", "/audio-versions", { campaign: idOf(issue) });
	assert.equal(created.status, 202, JSON.stringify(created.body));
	await runJobs();
}

function hear(user, issue, visitor = null, headers = {}) {
	const request = new Request(`https://${user.slug}.${SHARED_DOMAIN}/audio/${issue.archiveSlug}.mp3`, { headers });
	const run = () => m.audioRoute.GET(request, { params: Promise.resolve({ slug: user.slug, post: issue.archiveSlug }) });
	return visitor ? inBrowser(visitor, run) : anonymous(run);
}

describe("the Free plan", () => {
	test("has no audio: its quota is 0 and it says so", async () => {
		assert.equal(m.plans.FREE_PLAN.id, "free");
		assert.equal(m.plans.AUDIO_CHARACTERS_PER_MONTH.free, 0);
		const user = await publisher();
		await m.Account.updateOne({ _id: user.accountId }, { $set: { subscriptionStatus: "canceled" } });
		const account = await m.Account.findById(user.accountId).lean();
		assert.equal(m.plans.isOnFreeTier(account), true);
		assert.equal(m.plans.getAudioLimit(account), 0);
		const refused = await api(user, "POST", "/audio-versions", { campaign: idOf(user.issue) });
		assert.equal(refused.status, 402);
		assert.equal(refused.body.error.code, "audio_quota_exceeded");
		assert.equal(refused.body.error.message, "Audio versions aren't part of the Free plan: choose a paid plan to make one");
		assert.equal(requests.length, 0);
		assert.equal(await m.AudioUsage.countDocuments({ accountId: user.accountId }), 0);
	});

	test("an admin can still give one account some", async () => {
		const user = await publisher();
		await m.Account.updateOne({ _id: user.accountId }, { $set: { subscriptionStatus: "canceled", "limitOverrides.audioCharactersPerMonth": 5000 } });
		assert.equal((await api(user, "POST", "/audio-versions", { campaign: idOf(user.issue) })).status, 202);
		await runJobs();
	});
});

describe("a paid issue's audio, by tier", () => {
	test("goes to the readers whose tier can read the issue, and to no other", async () => {
		const user = await publisher();
		const issue = await addIssue(m, user, { subject: "For gold", audience: "paid", audienceTiers: ["gold"], html: paragraphs(2) });
		await audioFor(user, issue);
		const gold = await addReader(m, user, "gold@example.org", { tier: "paid", paidTierId: "gold", paidUntil: new Date(Date.now() + 30 * DAY) });
		const silver = await addReader(m, user, "silver@example.org", { tier: "paid", paidTierId: "silver", paidUntil: new Date(Date.now() + 30 * DAY) });
		const free = await addReader(m, user, "free@example.org");
		assert.equal((await hear(user, issue)).status, 401);
		assert.equal((await hear(user, issue, await signInReader(m, user, free, { issue }))).status, 403);
		assert.equal((await hear(user, issue, await signInReader(m, user, silver, { issue }))).status, 403, "a paid reader of another tier");
		const heard = await hear(user, issue, await signInReader(m, user, gold, { issue }), { range: "bytes=0-9" });
		assert.equal(heard.status, 206);
		assert.match(heard.headers.get("cache-control"), /^private/);
		await heard.arrayBuffer();
	});

	test("an issue for every paid tier opens for any of them", async () => {
		const user = await publisher();
		const issue = await addIssue(m, user, { subject: "For all paid", audience: "paid", html: paragraphs(2) });
		await audioFor(user, issue);
		const silver = await addReader(m, user, "silver2@example.org", { tier: "paid", paidTierId: "silver", paidUntil: new Date(Date.now() + 30 * DAY) });
		const plain = await addReader(m, user, "plain@example.org", { tier: "paid", paidUntil: new Date(Date.now() + 30 * DAY) });
		for (const reader of [silver, plain]) {
			const response = await hear(user, issue, await signInReader(m, user, reader, { issue }));
			assert.equal(response.status, 200, reader.email);
			await response.arrayBuffer();
		}
	});
});

describe("an issue the newsletter gates", () => {
	async function gated() {
		const user = await publisher();
		await m.Newsletter.updateOne({ accountId: user.accountId, _id: user.newsletterId }, { $set: { popup: { gate: { enabled: true, previewPercent: 30, freeLatest: 0 } } } });
		await audioFor(user, user.issue);
		return user;
	}

	test("opens its audio for a signed-in subscriber only, and is no public episode", async () => {
		const user = await gated();
		assert.equal((await hear(user, user.issue)).status, 401);
		const reader = await addReader(m, user, "subscriber@example.org");
		const heard = await hear(user, user.issue, await signInReader(m, user, reader));
		assert.equal(heard.status, 200);
		assert.match(heard.headers.get("cache-control"), /^private/);
		await heard.arrayBuffer();

		await api(user, "PATCH", "/audio-settings", { podcastEnabled: true });
		const feed = await anonymous(() => m.podcastRoute.GET(new Request("https://x.example.com/podcast.xml"), { params: Promise.resolve({ slug: user.slug }) }));
		assert.equal(childrenOf(childOf(parseXml(await feed.text()), "channel"), "item").length, 0);
	});

	test("is public again when the gate leaves the issue open", async () => {
		const user = await gated();
		await m.Newsletter.updateOne({ accountId: user.accountId, _id: user.newsletterId }, { $set: { "popup.gate.freeLatest": 5 } });
		const heard = await hear(user, user.issue);
		assert.equal(heard.status, 200);
		assert.match(heard.headers.get("cache-control"), /^public/);
		await heard.arrayBuffer();
	});
});

describe("the counters", () => {
	test("audio characters and the AI requests of a day are apart: making audio spends none of the other", async () => {
		const user = await publisher();
		await audioFor(user, user.issue);
		assert.equal(await m.AiUsage.countDocuments({ accountId: user.accountId }), 0);
		assert.ok((await api(user, "GET", "/audio-usage")).body.used > 0);
		assert.equal(m.plans.PLANS.every((plan) => plan.aiRequestsPerDay > 0), true);
		assert.equal(m.plans.FREE_PLAN.aiRequestsPerDay, 5, "Free keeps its AI requests and has no audio");
		const quota = await import("node:fs/promises").then(({ readFile }) => readFile(new URL("../lib/audio-quota.js", import.meta.url), "utf8"));
		assert.doesNotMatch(quota, /ai-usage|AiUsage/);
	});
});

describe("the lists that grew in the release", () => {
	test("the webhook events have audio.ready next to the automations' and the paid ones", () => {
		for (const type of ["audio.ready", "automation.step", "order.paid", "subscriber.upgraded", "campaign.sent"]) assert.ok(m.events.WEBHOOK_EVENT_TYPES.includes(type), type);
		assert.equal(new Set(m.events.WEBHOOK_EVENT_TYPES).size, m.events.WEBHOOK_EVENT_TYPES.length);
	});

	test("the sub-processors list ElevenLabs, dated by the notice, and Unsplash", () => {
		const names = [...m.subprocessors.SUBPROCESSORS, ...m.subprocessors.OPTIONAL_SUBPROCESSORS].map(({ name }) => name);
		assert.ok(names.includes("ElevenLabs") && names.includes("Unsplash"));
		const entry = m.subprocessors.SUBPROCESSORS.find(({ name }) => name === "ElevenLabs");
		assert.match(entry.purpose, /Not in use yet\. We email account owners at least 30 days before it starts handling data\.$/);
	});
});
