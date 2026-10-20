import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { memoryObjects } from "../lib/export-storage.js";
import { addIssue, addReader, createPublisher, importModels, inBrowser, signInReader } from "./helpers/community.mjs";
import { callApi, anonymous, as, jsonRequest, platformEmails, startTestApp, withEnv } from "./helpers/app.mjs";
import { ElevenLabsError, requests, resetVoice, setVoiceBehavior } from "./stubs/elevenlabs.mjs";
import { files } from "./stubs/opennext-cloudflare.mjs";
import { published } from "./stubs/qstash.mjs";

// Audio versions, end to end with the voice service stubbed: the job's steps and what each asks the voice, the month's
// characters, failures and starting again, what is kept and replaced, who may hear it, and what the dashboard and API say.

const VOICES = [
	{ id: "21m00Tcm4TlvDq8ikWAM", name: "Rachel", description: "Calm and clear", previewUrl: "https://example.com/rachel.mp3" },
	{ id: "AZnzlk1XvdvUeBnXmlld", name: "Domi", description: "Strong and warm", previewUrl: "https://example.com/domi.mp3" },
];
const RACHEL = VOICES[0].id;
const DOMI = VOICES[1].id;
const BYTES_PER_CHAR = 16;
const BYTES_PER_SECOND = 16_000;

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
		runAction: (await import("../lib/actions/run-action.js")).runAction,
		audio: await import("../lib/audio.js"),
		storage: await import("../lib/audio-storage.js"),
		accounts: await import("../lib/accounts.js"),
		Account: (await import("../models/Account.js")).default,
		AudioVersion: (await import("../models/AudioVersion.js")).default,
		AudioUsage: (await import("../models/AudioUsage.js")).default,
		WebhookDelivery: (await import("../models/WebhookDelivery.js")).default,
	};
	processed = published.length;
});

after(() => app?.stop());

beforeEach(() => resetVoice());

const sentence = (index) => `Sentence number ${index} is here to be read aloud by the voice. `;
// Paragraphs of about 870 characters: a part holds two of them, so six make three parts.
function paragraphs(count, offset = 0) {
	return Array.from({ length: count }, (_, index) => `<p>${Array.from({ length: 14 }, (__, i) => sentence(offset + index * 14 + i)).join("").trim()}</p>`).join("");
}

async function publisher(options = {}) {
	const user = await createPublisher(m, `audio${++counter}@example.com`, { issue: { subject: "The long weekend", html: paragraphs(9) }, ...options });
	return user;
}

const api = (user, method, path, body) => callApi(method, `/api/v1${path}`, { key: user.key, body });
const idOf = (issue) => String(issue._id);

async function runJobs() {
	const log = [];
	while (processed < published.length) {
		const job = published[processed++];
		if (!job.url.endsWith("/api/jobs/make-audio")) continue;
		// QStash delivers a job four times at most, trying again when the step answers 503 or throws.
		for (let delivery = 0; delivery < 4; delivery += 1) {
			try {
				const response = await m.jobRoute.POST(jsonRequest(job.url, { method: "POST", body: job.body }));
				const body = await response.json();
				log.push({ status: response.status, ...body });
				if (response.status !== 503) break;
			} catch (error) {
				log.push({ threw: error.message });
			}
		}
	}
	return log;
}

async function create(user, issue, input = {}) {
	return api(user, "POST", "/audio-versions", { campaign: idOf(issue), ...input });
}

async function makeAudio(user, issue, input = {}) {
	const created = await create(user, issue, input);
	assert.equal(created.status, 202, JSON.stringify(created.body));
	const log = await runJobs();
	const got = await api(user, "GET", `/audio-versions/${idOf(issue)}`);
	return { created: created.body, log, audio: got.body.audio };
}

const usageOf = async (user) => (await api(user, "GET", "/audio-usage")).body;

describe("making an audio version", () => {
	test("reads the issue part by part, ties each part to the ones before it, and joins them into one file", async () => {
		const user = await publisher();
		const estimate = await api(user, "GET", `/audio-usage?campaign=${idOf(user.issue)}`);
		assert.equal(estimate.status, 200, JSON.stringify(estimate.body));
		assert.equal(estimate.body.enabled, true);
		assert.equal(estimate.body.limit, 11_000);
		assert.equal(estimate.body.estimate.wouldExceed, false);
		assert.equal(estimate.body.estimate.scope, "public");
		assert.match(estimate.body.estimate.message, /^This will use about [\d,]+ of your 11,000 characters this month\.$/);
		const characters = estimate.body.estimate.characters;

		const created = await create(user, user.issue);
		assert.equal(created.status, 202, JSON.stringify(created.body));
		assert.deepEqual(
			{ status: created.body.status, voiceId: created.body.voiceId, scope: created.body.scope, characters: created.body.characters, progress: created.body.progress, created: created.body.created },
			{ status: "queued", voiceId: RACHEL, scope: "public", characters, progress: { done: 0, total: 3 }, created: true }
		);
		assert.deepEqual((await usageOf(user)).reserved, characters, "its characters are held while it is made");

		const log = await runJobs();
		assert.deepEqual(log.map(({ continued, done }) => continued?.part ?? (done ? "done" : "?")), [1, 2, 3, "done"]);

		assert.equal(requests.length, 3);
		const texts = requests.map(({ text }) => text);
		assert.ok(texts.every((text) => text.length <= 2500));
		assert.equal(texts.reduce((total, text) => total + text.length, 0), characters);
		assert.ok(texts[0].startsWith("The long weekend.\n\nSentence number 0 "));
		for (const request of requests) {
			assert.equal(request.voiceId, RACHEL);
			assert.equal(request.modelId, "eleven_multilingual_v2");
			assert.equal(request.outputFormat, "mp3_44100_128");
			assert.match(request.text, /[.!?]$/, "each part ends where a sentence does");
		}
		// Request stitching: the ids of the parts before it, and the start of the part after.
		assert.deepEqual(requests.map((request) => request.previousRequestIds ?? []), [[], ["req_1"], ["req_1", "req_2"]]);
		assert.deepEqual(requests.map((request) => request.previousText ?? ""), ["", "", ""]);
		assert.equal(requests[0].nextText, texts[1].slice(0, requests[0].nextText.length));
		assert.ok(requests[0].nextText.length > 100 && requests[0].nextText.length <= 400);
		assert.equal(requests[2].nextText ?? "", "", "the last part has nothing after it");

		const got = await api(user, "GET", `/audio-versions/${idOf(user.issue)}`);
		const { audio } = got.body;
		assert.equal(audio.status, "ready");
		assert.equal(audio.file.bytes, characters * BYTES_PER_CHAR);
		assert.equal(audio.file.seconds, Math.round((characters * BYTES_PER_CHAR) / BYTES_PER_SECOND));
		assert.equal(audio.file.scope, "public");
		assert.equal(audio.file.voiceId, RACHEL);
		assert.match(audio.file.url, new RegExp(`^https://${user.slug}\\.flockstackmail\\.com/audio/${user.issue.archiveSlug}\\.mp3\\?v=\\d+$`));
		assert.equal(audio.outOfDate, false);
		assert.deepEqual(audio.progress, { done: 3, total: 3 });

		// Byte-concatenation of the parts in order: the first text's bytes (marked 1), then 2, then 3.
		const stored = [...files.values()].find(({ contentType }) => contentType === "audio/mpeg").bytes;
		assert.equal(stored.length, audio.file.bytes);
		let offset = 0;
		texts.forEach((text, index) => {
			const end = offset + text.length * BYTES_PER_CHAR;
			assert.ok(stored.subarray(offset, end).every((byte) => byte === index + 1), `part ${index + 1}`);
			offset = end;
		});
		assert.deepEqual([...memoryObjects.keys()].filter((key) => key.startsWith(`audio/${user.accountId}/`)), [], "what waited for the job is cleaned up");

		const usage = await usageOf(user);
		assert.deepEqual({ used: usage.used, reserved: usage.reserved, left: usage.left }, { used: characters, reserved: 0, left: 11_000 - characters });
	});

	test("uses the newsletter's voice, an issue's own voice over it, and the model and format the owner sets", async () => {
		const user = await publisher();
		const set = await api(user, "PATCH", "/audio-settings", { voiceId: DOMI });
		assert.equal(set.status, 200, JSON.stringify(set.body));
		assert.equal(set.body.voiceId, DOMI);
		await withEnv({ ELEVENLABS_MODEL: "eleven_flash_v2_5", ELEVENLABS_OUTPUT_FORMAT: "mp3_44100_64" }, async () => {
			const first = await makeAudio(user, user.issue);
			assert.equal(first.audio.voiceId, DOMI);
			assert.ok(requests.every(({ voiceId, modelId, outputFormat }) => voiceId === DOMI && modelId === "eleven_flash_v2_5" && outputFormat === "mp3_44100_64"));
			assert.equal(first.audio.file.seconds, Math.round(first.audio.file.bytes / 8000), "the length follows the bit rate");
		});
		const other = await addIssue(m, user, { subject: "Another", html: paragraphs(2) });
		const own = await makeAudio(user, other, { voiceId: RACHEL });
		assert.equal(own.audio.voiceId, RACHEL);
		const unknown = await create(user, other, { voiceId: "notavoice1234" });
		assert.equal(unknown.status, 400);
		assert.match(unknown.body.error.message, /voiceId: pick one of the voices/);
	});

	test("does not stitch for a model that can't, and sends the text around a part instead of request ids otherwise lost", async () => {
		const user = await publisher();
		await withEnv({ ELEVENLABS_MODEL: "eleven_v3" }, async () => {
			await makeAudio(user, user.issue);
		});
		assert.equal(requests.length, 3);
		for (const request of requests) {
			assert.deepEqual(request.previousRequestIds ?? [], []);
			assert.equal(request.previousText ?? "", "");
			assert.equal(request.nextText ?? "", "");
		}
	});

	test("falls back to the end of the part before when the service gave no request id", async () => {
		const user = await publisher();
		setVoiceBehavior((_, number) => (number === 1 ? { requestId: null } : undefined));
		await makeAudio(user, user.issue);
		assert.deepEqual(requests[1].previousRequestIds ?? [], []);
		assert.ok(requests[1].previousText.length > 50 && requests[1].previousText.length <= 400);
		assert.ok(requests[0].text.endsWith(requests[1].previousText));
		assert.deepEqual(requests[2].previousRequestIds ?? [], [], "a part without an id in the last three breaks the chain");
	});

	test("is idempotent: asking again without a change reads nothing and counts nothing; a second ask while it's being made is a conflict", async () => {
		const user = await publisher();
		const first = await create(user, user.issue);
		const again = await create(user, user.issue);
		assert.equal(first.status, 202);
		assert.equal(again.status, 409);
		await runJobs();
		const used = (await usageOf(user)).used;
		const before = requests.length;
		const repeat = await create(user, user.issue);
		assert.equal(repeat.status, 202);
		assert.equal(repeat.body.created, false);
		assert.equal(repeat.body.status, "ready");
		assert.equal(requests.length, before);
		assert.equal((await runJobs()).length, 0);
		assert.equal((await usageOf(user)).used, used);
	});

	test("makes it again when the issue changed, replacing the audio and deleting the old file", async () => {
		const user = await publisher();
		const first = await makeAudio(user, user.issue);
		const oldKeys = [...files.keys()].filter((key) => key.startsWith(`accounts/${user.accountId}/audio/`));
		assert.equal(oldKeys.length, 1);
		await m.Campaign.updateOne({ accountId: user.accountId, _id: user.issue._id }, { $set: { html: paragraphs(4, 100) } });
		const changed = await api(user, "GET", `/audio-versions/${idOf(user.issue)}`);
		assert.equal(changed.body.audio.outOfDate, true);
		assert.equal(changed.body.audio.file.url, first.audio.file.url, "the old audio plays meanwhile");

		const second = await makeAudio(user, user.issue);
		assert.equal(second.created.created, true);
		assert.equal(second.audio.outOfDate, false);
		assert.notEqual(second.audio.file.bytes, first.audio.file.bytes);
		const keys = [...files.keys()].filter((key) => key.startsWith(`accounts/${user.accountId}/audio/`));
		assert.equal(keys.length, 1);
		assert.notEqual(keys[0], oldKeys[0]);
		assert.equal(await m.AudioVersion.countDocuments({ accountId: user.accountId, campaignId: user.issue._id }), 1);
	});

	test("deletes it: the file, the page's audio and the email link go, the characters used stay counted", async () => {
		const user = await publisher();
		await makeAudio(user, user.issue, { emailLink: true });
		const used = (await usageOf(user)).used;
		assert.ok(used > 0);
		assert.equal((await m.Campaign.findOne({ accountId: user.accountId, _id: user.issue._id }).lean()).listen.minutes >= 1, true);
		const deleted = await api(user, "DELETE", `/audio-versions/${idOf(user.issue)}`);
		assert.deepEqual(deleted.body, { deleted: true });
		assert.equal([...files.keys()].filter((key) => key.startsWith(`accounts/${user.accountId}/audio/`)).length, 0);
		assert.equal((await api(user, "GET", `/audio-versions/${idOf(user.issue)}`)).body.audio, null);
		assert.equal((await m.Campaign.findOne({ accountId: user.accountId, _id: user.issue._id }).lean()).listen, undefined);
		assert.equal((await usageOf(user)).used, used);
		assert.deepEqual((await api(user, "DELETE", `/audio-versions/${idOf(user.issue)}`)).body, { deleted: false });
	});

	test("a deleted draft takes its audio with it", async () => {
		const user = await publisher();
		const draft = await addIssue(m, user, { subject: "Draft to drop", status: "draft", html: paragraphs(2) });
		await makeAudio(user, draft);
		assert.equal([...files.keys()].filter((key) => key.startsWith(`accounts/${user.accountId}/audio/`)).length, 1);
		const deleted = await api(user, "DELETE", `/campaigns/${idOf(draft)}`);
		assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
		assert.equal([...files.keys()].filter((key) => key.startsWith(`accounts/${user.accountId}/audio/`)).length, 0);
		assert.equal(await m.AudioVersion.countDocuments({ accountId: user.accountId, campaignId: draft._id }), 0);
	});

	test("refuses an issue with nothing to read, one that is too long and one of another account", async () => {
		const user = await publisher();
		const empty = await addIssue(m, user, { subject: "", html: '<img src="https://example.com/a.png">' });
		const none = await create(user, empty);
		assert.equal(none.status, 400);
		assert.match(none.body.error.message, /no text to read/);
		const long = await addIssue(m, user, { subject: "Long", html: paragraphs(70) });
		const tooLong = await create(user, long);
		assert.equal(tooLong.status, 400);
		assert.match(tooLong.body.error.message, /too long for one audio version/);
		const stranger = await publisher();
		assert.equal((await create(stranger, user.issue)).status, 404);
		assert.equal(requests.length, 0);
	});

	test("a step run twice adds nothing: a part already kept is not read again, and a duplicate job leaves the audio right", async () => {
		const user = await publisher();
		await create(user, user.issue);
		const [job] = published.slice(processed);
		const audio = await m.AudioVersion.findOne({ accountId: user.accountId, campaignId: user.issue._id }).lean();
		// A step that was cut off after it kept the first part but before it saved: the part waits in storage.
		const prefix = m.storage.getAudioPrefix(audio.accountId, audio._id);
		memoryObjects.set(`${prefix}part-0.mp3`, new Uint8Array(1000).fill(9));
		const log = [];
		for (const delivery of [job, job]) {
			const response = await m.jobRoute.POST(jsonRequest(delivery.url, { method: "POST", body: delivery.body }));
			log.push(await response.json());
		}
		await runJobs();
		assert.equal(requests.length, 2, "part one was adopted, parts two and three were read once each");
		const done = await m.AudioVersion.findOne({ accountId: user.accountId, campaignId: user.issue._id }).lean();
		assert.equal(done.status, "ready");
		assert.equal(done.file.bytes, 1000 + (requests[0].text.length + requests[1].text.length) * BYTES_PER_CHAR);
	});
});

describe("the month's characters", () => {
	test("an audio version that would go past what is left is refused before anything is read, with how much is left", async () => {
		const user = await publisher();
		await m.accounts.setAudioLimitOverride(user.accountId, 500);
		const refused = await create(user, user.issue);
		assert.equal(refused.status, 402);
		assert.equal(refused.body.error.code, "audio_quota_exceeded");
		assert.match(refused.body.error.message, /^This needs about [\d,]+ characters of audio, and this month has 500 left of 500\. The count starts over on the 1st\.$/);
		assert.equal(requests.length, 0);
		assert.equal(await m.AudioVersion.countDocuments({ accountId: user.accountId }), 0);
		const usage = await usageOf(user);
		assert.deepEqual({ limit: usage.limit, used: usage.used, reserved: usage.reserved, left: usage.left }, { limit: 500, used: 0, reserved: 0, left: 500 });
		const estimate = await api(user, "GET", `/audio-usage?campaign=${idOf(user.issue)}`);
		assert.equal(estimate.body.estimate.wouldExceed, true);
		assert.match(estimate.body.estimate.message, /Only 500 are left/);
	});

	test("an admin's number wins over the plan's, in either direction, and saving the other limits keeps it", async () => {
		const user = await publisher();
		await m.accounts.setAudioLimitOverride(user.accountId, 60_000);
		assert.equal((await usageOf(user)).limit, 60_000);
		await m.accounts.setLimitOverrides(user.accountId, { emailsPerMonth: 10, subscribers: 100 });
		assert.equal((await usageOf(user)).limit, 60_000);
		await m.accounts.setAudioLimitOverride(user.accountId, undefined);
		assert.equal((await usageOf(user)).limit, 11_000);
		await m.accounts.setAudioLimitOverride(user.accountId, 0);
		const none = await create(user, user.issue);
		assert.equal(none.status, 402);
		assert.match(none.body.error.message, /plan has no audio versions/);
	});

	test("a job holds its characters, so another that wouldn't fit is refused while it runs; they come back when it ends", async () => {
		const user = await publisher();
		const other = await addIssue(m, user, { subject: "Second", html: paragraphs(9, 500) });
		const first = await api(user, "GET", `/audio-usage?campaign=${idOf(user.issue)}`);
		const need = first.body.estimate.characters;
		await m.accounts.setAudioLimitOverride(user.accountId, need + 100);
		assert.equal((await create(user, user.issue)).status, 202);
		const refused = await create(user, other);
		assert.equal(refused.status, 402);
		assert.match(refused.body.error.message, /this month has 100 left of /);
		await runJobs();
		assert.equal((await usageOf(user)).left, 100);
		assert.equal((await create(user, other)).status, 402);
		await m.accounts.setAudioLimitOverride(user.accountId, need * 2 + 100);
		assert.equal((await create(user, other)).status, 202);
	});

	test("the month's count starts over with the month", async () => {
		const user = await publisher();
		await makeAudio(user, user.issue);
		const usage = await usageOf(user);
		assert.ok(usage.used > 0);
		assert.match(usage.month, /^\d{4}-\d{2}$/);
		const next = new Date(usage.resetsAt);
		assert.equal(next.getUTCDate(), 1);
		assert.ok(next > new Date());
		const march = await m.AudioUsage.countDocuments({ accountId: user.accountId, month: usage.month });
		assert.equal(march, 1);
		const quota = await import("../lib/audio-quota.js");
		const later = await quota.getAudioQuota(await m.Account.findById(user.accountId).lean(), new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 15)));
		assert.deepEqual({ used: later.used, left: later.left }, { used: 0, left: 11_000 });
	});

	test("no plan, no audio; a self-hosted server has none of the limits", async () => {
		const user = await publisher();
		await m.Account.updateOne({ _id: user.accountId }, { $set: { subscriptionStatus: "canceled" } });
		const refused = await create(user, user.issue);
		assert.equal(refused.status, 402);
		await m.Account.updateOne({ _id: user.accountId }, { $set: { subscriptionStatus: "active" } });
		await withEnv({ FLOCKSTACK_CLOUD: "false" }, async () => {
			// Keys are for the cloud's regions only; a self-hosted server's callers run the same actions directly.
			const run = async (name, input) => m.runAction(name, { account: await m.Account.findById(user.accountId).lean(), user: { id: String(user.userId), email: user.email }, input, via: "api" });
			const usage = await run("get_audio_usage", {});
			assert.deepEqual({ limit: usage.limit, left: usage.left }, { limit: null, left: null });
			const made = await run("create_audio_version", { campaign: idOf(user.issue) });
			assert.equal(made.status, "queued");
			await runJobs();
			assert.equal((await run("get_audio_version", { id: idOf(user.issue) })).audio.status, "ready");
			assert.ok((await run("get_audio_usage", {})).used > 0);
		});
	});
});

describe("when the voice service fails", () => {
	test("a busy service is tried again, and the characters are counted once", async () => {
		const user = await publisher();
		setVoiceBehavior((_, number) => {
			if (number === 2) throw new ElevenLabsError("The voice service is busy", { status: 429, retryable: true });
		});
		const { log, audio } = await makeAudio(user, user.issue);
		assert.deepEqual(log.map(({ threw }) => threw ?? null).filter(Boolean), ["The voice service is busy"]);
		assert.equal(audio.status, "ready");
		assert.equal(requests.length, 4, "part two was asked for twice");
		const stored = await m.AudioVersion.findOne({ accountId: user.accountId, campaignId: user.issue._id }).lean();
		assert.equal((await usageOf(user)).used, audio.characters);
		assert.equal(stored.attempts, 0);
	});

	test("after the fourth try it fails with the part that failed, counting only what was read", async () => {
		const user = await publisher();
		setVoiceBehavior((_, number) => {
			if (number >= 2) throw new ElevenLabsError("The voice service is busy", { status: 429, retryable: true });
		});
		const created = await create(user, user.issue);
		const log = await runJobs();
		assert.equal(log.filter(({ threw }) => threw).length, 3, "the first three tries threw, the fourth failed the job");
		assert.match(log.at(-1).failed, /busy/);
		const { audio } = (await api(user, "GET", `/audio-versions/${idOf(user.issue)}`)).body;
		assert.equal(audio.status, "failed");
		assert.equal(audio.errorPart, 2);
		assert.equal(audio.error, "Part 2 of 3 failed: The voice service is busy");
		assert.equal(audio.file, null);
		const firstPart = requests[0].text.length;
		const usage = await usageOf(user);
		assert.deepEqual({ used: usage.used, reserved: usage.reserved }, { used: firstPart, reserved: 0 });
		assert.equal(created.body.characters > firstPart, true);
	});

	test("a problem no retry changes fails at once, and tells the owner when it's the key or the credit", async () => {
		const user = await publisher();
		const before = platformEmails.length;
		setVoiceBehavior(() => {
			throw new ElevenLabsError("The voice service refused FlockStack's key", { status: 401, setup: true });
		});
		await create(user, user.issue);
		const log = await runJobs();
		assert.equal(log.length, 1);
		const { audio } = (await api(user, "GET", `/audio-versions/${idOf(user.issue)}`)).body;
		assert.equal(audio.status, "failed");
		assert.equal(audio.error, "Part 1 of 3 failed: The voice service refused FlockStack's key");
		assert.equal((await usageOf(user)).used, 0, "nothing was read, nothing is counted");
		assert.ok(platformEmails.slice(before).some(({ subject }) => /can't reach the voice service/.test(subject)));
	});

	test("an audio version that failed goes on from the parts it kept when it's made again", async () => {
		const user = await publisher();
		setVoiceBehavior((_, number) => {
			if (number === 2) throw new ElevenLabsError("The voice service refused this text: too long", { status: 422 });
		});
		await create(user, user.issue);
		await runJobs();
		assert.equal(requests.length, 2);
		const total = (await api(user, "GET", `/audio-versions/${idOf(user.issue)}`)).body.audio.characters;
		resetVoice();
		const again = await create(user, user.issue);
		assert.equal(again.status, 202);
		assert.equal(again.body.created, true);
		assert.deepEqual(again.body.progress, { done: 1, total: 3 }, "the first part is kept");
		await runJobs();
		assert.equal(requests.length, 2, "only the parts left were read");
		assert.ok(requests[0].text.startsWith("Sentence number"), "it starts at part two");
		assert.equal(requests[0].previousRequestIds?.length ? requests[0].previousRequestIds[0] : null, "req_1", "and is tied to the part kept from the first try");
		const { audio } = (await api(user, "GET", `/audio-versions/${idOf(user.issue)}`)).body;
		assert.equal(audio.status, "ready");
		assert.equal((await usageOf(user)).used, total, "each part counted once");
		assert.equal(audio.error, null);
		const stored = [...files.values()].find(({ contentType }) => contentType === "audio/mpeg").bytes;
		assert.ok(stored.subarray(0, 100).every((byte) => byte === 1), "the first part is the one from the first try");
	});

	test("a job that never moved on is failed when the next ask finds it stale, giving its characters back", async () => {
		const user = await publisher();
		await create(user, user.issue);
		assert.ok((await usageOf(user)).reserved > 0);
		await m.AudioVersion.collection.updateOne({ campaignId: user.issue._id }, { $set: { updatedAt: new Date(Date.now() - 2 * 3600_000) } });
		const again = await create(user, user.issue);
		assert.equal(again.status, 202, JSON.stringify(again.body));
		await runJobs();
		const usage = await usageOf(user);
		assert.equal(usage.reserved, 0);
	});
});

describe("hiding it while it is off", () => {
	test("AUDIO_ENABLED off hides the voices, refuses the actions and reaches no voice", async () => {
		const user = await publisher();
		await makeAudio(user, user.issue);
		const before = requests.length;
		await withEnv({ AUDIO_ENABLED: "false" }, async () => {
			assert.deepEqual((await api(user, "GET", "/audio-voices")).body, { enabled: false, voices: [] });
			assert.equal((await api(user, "GET", "/audio-usage")).body.enabled, false);
			const refused = await create(user, user.issue, {});
			assert.equal(refused.status, 503);
			assert.equal(refused.body.error.code, "unavailable");
			assert.match(refused.body.error.message, /aren't available yet/);
			assert.doesNotMatch(JSON.stringify(refused.body), /eleven/i);
			assert.equal(m.audio.listVoices().length, 2, "the voices are configured, and still hidden");
			const audioRoute = await import("../app/archive/[slug]/audio/[post]/route.js");
			const response = await anonymous(() => audioRoute.GET(new Request("http://localhost/x"), { params: Promise.resolve({ slug: user.slug, post: user.issue.archiveSlug }) }));
			assert.equal(response.status, 404, "an audio file that was made is not served while it is off");
			const podcastRoute = await import("../app/archive/[slug]/podcast/route.js");
			await api(user, "PATCH", "/audio-settings", { podcastEnabled: true }).catch(() => null);
			assert.equal((await anonymous(() => podcastRoute.GET(new Request("http://localhost/x"), { params: Promise.resolve({ slug: user.slug }) }))).status, 404);
			const page = await import("../app/(app)/audio/page.js");
			await assert.rejects(as(user, () => page.default()), (error) => error?.digest?.includes?.("NEXT_HTTP_ERROR_FALLBACK;404") || error?.name === "NotFoundError" || /not.?found/i.test(String(error?.message ?? error)));
			const card = await import("../lib/audio-dashboard.js");
			assert.equal(await card.getAudioCardProps({ account: await m.Account.findById(user.accountId).lean(), user: { id: String(user.userId) }, campaign: user.issue, newsletter: user.newsletter }), null);
		});
		assert.equal(requests.length, before);
	});

	test("on FlockStack Cloud the flag does nothing until the notice has gone out", async () => {
		const user = await publisher();
		await withEnv({ NODE_ENV: "production", ELEVENLABS_NOTICE_SENT_ON_TEST: "2026-01-01" }, async () => {
			assert.equal((await api(user, "GET", "/audio-voices").catch(() => ({ body: {} }))).body?.enabled ?? false, false);
		});
		await withEnv({ ELEVENLABS_NOTICE_SENT_ON_TEST: "" }, async () => {
			assert.deepEqual((await api(user, "GET", "/audio-voices")).body, { enabled: false, voices: [] });
			assert.equal((await create(user, user.issue)).status, 503);
		});
		await withEnv({ ELEVENLABS_NOTICE_SENT_ON_TEST: "2999-01-01" }, async () => {
			assert.equal((await create(user, user.issue)).status, 503);
		});
		assert.equal(requests.length, 0);
	});

	test("without voices, or without the key, there is nothing to make", async () => {
		const user = await publisher();
		await withEnv({ ELEVENLABS_VOICES: "" }, async () => {
			assert.deepEqual((await api(user, "GET", "/audio-voices")).body, { enabled: false, voices: [] });
			assert.equal((await create(user, user.issue)).status, 503);
		});
		await withEnv({ ELEVENLABS_API_KEY: "" }, async () => {
			assert.equal((await api(user, "GET", "/audio-voices")).body.enabled, false);
			const refused = await create(user, user.issue);
			assert.equal(refused.status, 503);
			assert.match(refused.body.error.message, /aren't set up on this server/);
		});
	});
});

describe("voices and settings", () => {
	test("list the owner's voices with a sample each, and take a default voice from them", async () => {
		const user = await publisher();
		const { body } = await api(user, "GET", "/audio-voices");
		assert.equal(body.enabled, true);
		assert.deepEqual(body.voices, VOICES.map(({ id, name, description, previewUrl }) => ({ id, name, description, previewUrl })));
		const set = await api(user, "PATCH", "/audio-settings", { voiceId: DOMI });
		assert.equal(set.body.voiceId, DOMI);
		assert.equal((await api(user, "PATCH", "/audio-settings", { voiceId: "nobody-here" })).status, 400);
		assert.equal((await api(user, "PATCH", "/audio-settings", { voiceId: "" })).body.voiceId, null);
	});

	test("turn the podcast on only for a website that is on, and check the owner email and category", async () => {
		const user = await publisher();
		const on = await api(user, "PATCH", "/audio-settings", { podcastEnabled: true, podcastCategory: "Technology", podcastExplicit: false, podcastOwnerEmail: "Owner@Example.com" });
		assert.equal(on.status, 200, JSON.stringify(on.body));
		assert.deepEqual(on.body.podcast, { enabled: true, feedUrl: `https://${user.slug}.flockstackmail.com/podcast.xml`, category: "Technology", explicit: false, ownerEmail: "owner@example.com" });
		assert.equal((await api(user, "PATCH", "/audio-settings", { podcastOwnerEmail: "not an email" })).status, 400);
		assert.equal((await api(user, "PATCH", "/audio-settings", { podcastCategory: "Cooking with robots" })).status, 400);
		assert.equal((await api(user, "PATCH", "/audio-settings", { podcastOwnerEmail: "" })).body.podcast.ownerEmail, null);
		await m.Newsletter.updateOne({ accountId: user.accountId, _id: user.newsletterId }, { $set: { archiveEnabled: false } });
		const off = await api(user, "PATCH", "/audio-settings", { podcastEnabled: true });
		assert.equal(off.status, 409);
		assert.match(off.body.error.message, /website on first/);
	});
});
