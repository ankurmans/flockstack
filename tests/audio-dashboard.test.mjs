import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { addIssue, createPublisher, importModels } from "./helpers/community.mjs";
import { as, jsonRequest, startTestApp, withEnv } from "./helpers/app.mjs";
import { requests, resetVoice } from "./stubs/elevenlabs.mjs";
import { published } from "./stubs/qstash.mjs";

// The dashboard: the audio card on an issue's page, the Audio page, the server actions behind them, and the admin's number.

const VOICES = [
	{ id: "21m00Tcm4TlvDq8ikWAM", name: "Rachel", description: "Calm and clear", previewUrl: "https://example.com/rachel.mp3" },
	{ id: "AZnzlk1XvdvUeBnXmlld", name: "Domi", description: "Strong and warm", previewUrl: null },
];

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
		TooltipProvider: (await import("../components/ui/tooltip.jsx")).TooltipProvider,
		campaignPage: (await import("../app/(app)/campaigns/[id]/page.js")).default,
		audioPage: (await import("../app/(app)/audio/page.js")).default,
		actions: await import("../app/(app)/audio/actions.js"),
		jobRoute: await import("../app/api/jobs/make-audio/route.js"),
		adminActions: await import("../app/admin/actions.js"),
		NavLinks: (await import("../components/NavLinks.jsx")).default,
		accounts: await import("../lib/accounts.js"),
		Account: (await import("../models/Account.js")).default,
	};
	processed = published.length;
});

after(() => app?.stop());
beforeEach(() => resetVoice());

const text = (markup) => markup.replace(/<[^>]+>/g, " ").replace(/&#x27;|&apos;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");
const paragraphs = (count) => Array.from({ length: count }, (_, index) => `<p>${Array.from({ length: 14 }, (__, i) => `Sentence number ${index * 14 + i} is here to be read aloud by the voice.`).join(" ")}</p>`).join("");

async function render(user, page, props = {}) {
	const element = await as(user, () => page(props));
	return renderToStaticMarkup(createElement(m.TooltipProvider, null, element));
}

async function publisher() {
	return createPublisher(m, `audiodash${++counter}@example.com`, { issue: { subject: "Sent issue", html: paragraphs(3) } });
}

async function runJobs() {
	while (processed < published.length) {
		const job = published[processed++];
		if (!job.url.endsWith("/api/jobs/make-audio")) continue;
		await m.jobRoute.POST(jsonRequest(job.url, { method: "POST", body: job.body }));
	}
}

describe("the audio card on an issue", () => {
	test("tells a draft's writer what it will use of the month before anything is read", async () => {
		const user = await publisher();
		const draft = await addIssue(m, user, { subject: "A draft", status: "draft", html: paragraphs(3), archiveSlug: undefined });
		const markup = await render(user, m.campaignPage, { params: Promise.resolve({ id: String(draft._id) }) });
		const html = text(markup);
		assert.match(html, /Audio version/);
		assert.match(html, /Create audio version/);
		assert.match(html, /This will use about [\d,]+ of your 11,000 characters this month\./);
		assert.match(markup, /aria-label="Listen to a sample of Rachel"/);
		assert.match(html, /Calm and clear/);
		assert.match(html, /Listen to this issue/);
		assert.equal(requests.length, 0);
	});

	test("on a sent issue's report plays the audio once it is made, and offers to make it again after a change", async () => {
		const user = await publisher();
		const done = await as(user, () => m.actions.createAudio({ campaignId: String(user.issue._id), emailLink: true }));
		assert.equal(done.audio.status, "queued", JSON.stringify(done));
		await runJobs();
		const report = await render(user, m.campaignPage, { params: Promise.resolve({ id: String(user.issue._id) }) });
		const html = text(report);
		assert.match(html, /Create again/);
		assert.match(html, /Delete audio/);
		assert.match(report, new RegExp(`<audio[^>]*src="/api/audio/${user.issue._id}\\?v=\\d+"`));
		assert.match(html, /\d+:\d{2} · [\d.]+ (KB|MB) · [\d,]+ characters/);
		await m.Campaign.updateOne({ accountId: user.accountId, _id: user.issue._id }, { $set: { html: paragraphs(1) } });
		assert.match(text(await render(user, m.campaignPage, { params: Promise.resolve({ id: String(user.issue._id) }) })), /The issue changed after this audio was made/);
	});

	test("says what an issue for paid subscribers only does, and has no email link for it", async () => {
		const user = await publisher();
		const paid = await addIssue(m, user, { subject: "Members", audience: "paid", html: paragraphs(1) });
		const html = text(await render(user, m.campaignPage, { params: Promise.resolve({ id: String(paid._id) }) }));
		assert.match(html, /for paid subscribers only, so only paid readers hear it/);
		assert.doesNotMatch(html, /Opens the issue's emails with a link/);
	});

	test("points an account whose plan has no audio to the plans, and is gone while audio is off", async () => {
		const user = await publisher();
		await m.accounts.setAudioLimitOverride(user.accountId, 0);
		assert.match(text(await render(user, m.campaignPage, { params: Promise.resolve({ id: String(user.issue._id) }) })), /Audio versions aren't part of the Free plan/);
		await m.accounts.setAudioLimitOverride(user.accountId, undefined);
		await withEnv({ AUDIO_ENABLED: "false" }, async () => {
			const html = text(await render(user, m.campaignPage, { params: Promise.resolve({ id: String(user.issue._id) }) }));
			assert.doesNotMatch(html, /Audio version|Create audio version/);
		});
	});

	test("the server actions behind it return the API's answers, and errors as a message", async () => {
		const user = await publisher();
		const refused = await as(user, () => m.actions.createAudio({ campaignId: "not-an-issue" }));
		assert.match(refused.error, /Campaign not found/);
		const created = await as(user, () => m.actions.createAudio({ campaignId: String(user.issue._id) }));
		assert.equal(created.audio.status, "queued");
		const again = await as(user, () => m.actions.createAudio({ campaignId: String(user.issue._id) }));
		assert.match(again.error, /being made/);
		await runJobs();
		const got = await as(user, () => m.actions.getAudio(String(user.issue._id)));
		assert.equal(got.audio.status, "ready");
		const cost = await as(user, () => m.actions.getAudioCost(String(user.issue._id)));
		assert.equal(cost.estimate.wouldExceed, false);
		const linked = await as(user, () => m.actions.setListenLink({ campaignId: String(user.issue._id), emailLink: true }));
		assert.equal(linked.audio.emailLink, true);
		assert.deepEqual(await as(user, () => m.actions.removeAudio(String(user.issue._id))), { ok: true });
		assert.equal((await as(user, () => m.actions.getAudio(String(user.issue._id)))).audio, null);
	});
});

describe("the Audio page", () => {
	test("shows the month's characters, the voices with a sample each and the podcast settings", async () => {
		const user = await publisher();
		const html = text(await render(user, m.audioPage));
		assert.match(html, /Characters this month/);
		assert.match(html, /0 of 11,000/);
		assert.match(html, /The count starts over on/);
		assert.match(html, /Rachel/);
		assert.match(html, /Calm and clear/);
		assert.match(html, /Domi/);
		assert.match(html, /Podcast/);
		assert.match(html, /an issue for paid subscribers only never is/);
		assert.equal((html.match(/Listen to a sample/g) ?? []).length, 1, "only a voice with a sample gets the button");
	});

	test("with the podcast on gives the feed address and the steps for Apple Podcasts and Spotify", async () => {
		const user = await publisher();
		const saved = await as(user, () => m.actions.saveAudioSettings({ newsletterId: user.newsletterId, voiceId: "", podcastEnabled: true, podcastCategory: "News", podcastExplicit: false, podcastOwnerEmail: "" }));
		assert.equal(saved.ok, true, JSON.stringify(saved));
		const html = await render(user, m.audioPage);
		const plain = text(html);
		assert.match(plain, new RegExp(`https://${user.slug}\\.flockstackmail\\.com/podcast\\.xml`));
		assert.match(plain, /Apple Podcasts Connect/);
		assert.match(plain, /Spotify for Creators/);
		assert.match(plain, /Apple Podcasts and Spotify turn a show without an episode down/);
		assert.match(plain, /at least 1400 by 1400 pixels/, "no logo yet");
		assert.match(html, /href="https:\/\/podcastsconnect\.apple\.com"/);
		assert.match(html, /href="https:\/\/creators\.spotify\.com"/);
		const bad = await as(user, () => m.actions.saveAudioSettings({ newsletterId: user.newsletterId, podcastOwnerEmail: "nope" }));
		assert.match(bad.error, /use an email address/);
	});

	test("is not there while audio versions are off, and the menu has no link to it", async () => {
		const user = await publisher();
		await withEnv({ AUDIO_ENABLED: "false" }, async () => {
			await assert.rejects(render(user, m.audioPage), (error) => /NEXT_HTTP_ERROR_FALLBACK;404|NEXT_NOT_FOUND|not found/i.test(`${error?.digest ?? ""} ${error?.message ?? ""} ${error?.name ?? ""}`));
		});
		const links = (hasAudio) => renderToStaticMarkup(createElement(m.NavLinks, { isAdmin: false, hasAudio }));
		assert.doesNotMatch(links(false), /href="\/audio"/);
		assert.match(links(true), /href="\/audio"[^>]*>.*Audio/s);
		const order = [...links(true).matchAll(/href="(\/[a-z-]*)"/g)].map(([, href]) => href);
		assert.equal(order[order.indexOf("/audio") - 1], "/comments");
	});
});

describe("an admin's number", () => {
	test("is set from the limits form, kept when only the other limits are saved, and cleared with an empty field", async () => {
		const admin = await publisher();
		const form = (fields) => {
			const data = new FormData();
			for (const [key, value] of Object.entries({ accountId: String(admin.accountId), ...fields })) data.set(key, value);
			return data;
		};
		await withEnv({ ADMIN_EMAILS: admin.email }, async () => {
			const stored = async () => (await m.Account.findById(admin.accountId).lean()).limitOverrides?.audioCharactersPerMonth;
			assert.equal((await as(admin, () => m.adminActions.saveLimits(null, form({ emailsPerMonth: "", subscribers: "", audioCharactersPerMonth: "25,000" })))).ok, true);
			assert.equal(await stored(), 25_000);
			assert.equal((await as(admin, () => m.adminActions.saveLimits(null, form({ emailsPerMonth: "1000", subscribers: "50" })))).ok, true);
			assert.equal(await stored(), 25_000, "a form without the field leaves it");
			assert.equal((await as(admin, () => m.adminActions.saveLimits(null, form({ emailsPerMonth: "", subscribers: "", audioCharactersPerMonth: "" })))).ok, true);
			assert.equal(await stored(), undefined);
			assert.match((await as(admin, () => m.adminActions.saveLimits(null, form({ audioCharactersPerMonth: "lots" })))).error, /whole numbers/);
		});
	});
});
