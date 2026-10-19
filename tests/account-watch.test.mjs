import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, describe, test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import mongoose from "@/lib/docdb";
import { describeWatch, getActiveWatch, isGmailWatch, judgeWatch } from "../lib/account-watch-rules.js";
import { LIMITS, POSTMASTER, WATCH } from "../lib/config.js";
import { platformEmails, signIn, startTestApp, telegramMessages } from "./helpers/app.mjs";

// The early warning before an automatic block (lib/account-watch.js): its levels come from LIMITS, it is emailed to the
// owner and recorded for the admins once per issue per period, it shows on the dashboard while it lasts, and a spam trap
// has none.
const DAY_MS = 24 * 60 * 60 * 1000;

describe("levels", () => {
	test("half of each block level, never above the pause level, from the same LIMITS", () => {
		assert.equal(WATCH.bounceRate, Math.min(LIMITS.block.bounceRate / 2, LIMITS.pause.bounceRate));
		assert.equal(WATCH.complaintRate, Math.min(LIMITS.block.complaintRate / 2, LIMITS.pause.complaintRate));
		assert.equal(WATCH.gmailRate, Math.min(POSTMASTER.blockRate / 2, POSTMASTER.pauseRate));
		for (const [watch, block] of [[WATCH.bounceRate, LIMITS.block.bounceRate], [WATCH.complaintRate, LIMITS.block.complaintRate], [WATCH.gmailRate, POSTMASTER.blockRate]]) {
			assert.ok(watch > 0 && watch <= block / 2, `${watch} warns well before ${block}`);
		}
	});

	test("a rate past the level with its minimum count warns; at the level, or with fewer, nothing", () => {
		const issues = (counts) => judgeWatch(counts).map(({ issue }) => issue);
		const atBounces = Math.round(WATCH.bounceRate * 1000);
		assert.deepEqual(issues({ sent: 1000, bounced: atBounces }), [], "exactly at the level");
		assert.deepEqual(issues({ sent: 1000, bounced: atBounces + 1 }), ["bounces"]);
		assert.deepEqual(issues({ sent: 100, bounced: WATCH.minBounces - 1 }), [], "a few bounces never warn, whatever the rate");
		assert.deepEqual(issues({ sent: 100_000, complained: WATCH.minComplaints - 1 }), []);
		assert.deepEqual(issues({ sent: 100, complained: WATCH.minComplaints - 1 }), [], "one complaint never warns");
		assert.deepEqual(issues({ sent: 2000, complained: WATCH.minComplaints, bounced: 60 }), ["bounces", "complaints"]);
		assert.deepEqual(issues({ sent: 0 }), []);
		const [bounces] = judgeWatch({ sent: 600, bounced: 13 });
		assert.deepEqual(bounces, { issue: "bounces", rate: 13 / 600, limit: WATCH.bounceRate, count: 13, sent: 600 });

		assert.equal(isGmailWatch(WATCH.gmailRate), true);
		assert.equal(isGmailWatch(WATCH.gmailRate / 2), false);
		assert.equal(isGmailWatch(POSTMASTER.blockRate), false, "the block level blocks instead");
	});

	test("what the owner reads names the numbers, the block level and what to do", () => {
		const bounces = describeWatch({ issue: "bounces", rate: 13 / 600, count: 13, sent: 600 });
		assert.equal(bounces.title, "Bounces are getting close to a block");
		assert.match(bounces.detail, /^2\.17% of the emails you sent over the last 7 days bounced \(13 of 600\)\. At 5\.00% with 10 bounces, FlockStack blocks the account/);
		assert.match(bounces.action, /confirmed opt-in/);
		assert.match(describeWatch({ issue: "complaints", rate: 0.001, count: 2, sent: 2000 }).action, /asked for your emails/);
		assert.match(describeWatch({ issue: "gmail", rate: 0.001 }).detail, /Gmail reported a spam rate of 0\.10%.*At 0\.30%/);
		assert.match(describeWatch({ issue: "provider", detail: "SES finding: DMARC (low impact)" }).summary, /^SES finding: DMARC \(low impact\)\. A high-impact finding/);
		for (const issue of ["bounces", "complaints", "gmail", "provider"]) {
			const text = describeWatch({ issue, rate: 0.03, count: 3, sent: 100, detail: "SES finding: X" });
			assert.doesNotMatch(Object.values(text).join(" "), /spam trap|cheap/i, issue);
		}
	});
});

describe("on an account", () => {
	let app;
	let m;

	before(async () => {
		app = await startTestApp();
		m = {
			watch: await import("../lib/account-watch.js"),
			health: await import("../lib/account-health.js"),
			tenantEvents: await import("../lib/tenant-events.js"),
			banner: await import("../components/BannerWatch.jsx"),
			Account: (await import("../models/Account.js")).default,
			Alert: (await import("../models/Alert.js")).default,
			Message: (await import("../models/Message.js")).default,
		};
	});

	after(() => app?.stop());

	const subjectsSince = (index) => platformEmails.slice(index).map(({ to, subject }) => `${to.join(",")} ${subject}`).sort();
	const load = (user) => m.Account.findById(user.accountId).lean();

	test("is emailed to the owner and recorded for the admins once per issue per period, however often it is seen", async () => {
		const user = await signIn("watch-once@example.com");
		const telegram = telegramMessages.length;
		let index = platformEmails.length;
		assert.equal(await m.watch.noteWatch(user.accountId, { issue: "bounces", rate: 0.03, limit: WATCH.bounceRate, count: 30, sent: 1000 }), true);
		assert.deepEqual(subjectsSince(index), ["admin@example.com [FlockStack] Account close to a block", "watch-once@example.com [FlockStack] Bounces are getting close to a block"]);
		const owner = platformEmails.find(({ to, subject }) => to.includes("watch-once@example.com") && subject.includes("Bounces"));
		assert.match(owner.text, /3\.00% of the emails you sent over the last 7 days bounced \(30 of 1,000\)/);
		assert.match(owner.text, /What to do: /);
		assert.equal(telegramMessages.length, telegram, "a warning is no admin emergency");

		index = platformEmails.length;
		await m.watch.noteWatch(user.accountId, { issue: "bounces", rate: 0.035, limit: WATCH.bounceRate, count: 35, sent: 1000 });
		assert.deepEqual(subjectsSince(index), [], "the same issue again in the period");
		assert.equal((await load(user)).watch.bounces.count, 35, "the dashboard shows the latest numbers");

		await m.watch.noteWatch(user.accountId, { issue: "complaints", rate: 0.001, limit: WATCH.complaintRate, count: 2, sent: 2000 });
		assert.deepEqual(subjectsSince(index), ["admin@example.com [FlockStack] Account close to a block", "watch-once@example.com [FlockStack] Spam complaints are getting close to a block"]);

		index = platformEmails.length;
		const longAgo = new Date(Date.now() - (WATCH.periodDays + 1) * DAY_MS);
		await m.Alert.updateMany({ accountId: user.accountId, key: "watch-bounces" }, { $set: { lastSentAt: longAgo } });
		await m.Alert.updateMany({ accountId: null, key: `account-watch:${user.accountId}:bounces` }, { $set: { lastSentAt: longAgo } });
		await m.watch.noteWatch(user.accountId, { issue: "bounces", rate: 0.03, limit: WATCH.bounceRate, count: 30, sent: 1000 });
		assert.equal(subjectsSince(index).length, 2, "the next period, once more");
	});

	test("a blocked account gets none: its block says more", async () => {
		const user = await signIn("watch-blocked@example.com");
		await m.Account.updateOne({ _id: user.accountId }, { $set: { status: "paused", pauseReason: "By hand", pausedBy: "admin" } });
		const index = platformEmails.length;
		assert.equal(await m.watch.noteWatch(user.accountId, { issue: "gmail", rate: 0.001, limit: WATCH.gmailRate }), false);
		assert.deepEqual(subjectsSince(index), []);
		assert.equal((await load(user)).watch, undefined);
	});

	test("the 7-day check notes it past the level and clears it back under", async () => {
		const user = await signIn("watch-health@example.com");
		const now = Date.now();
		const docs = Array.from({ length: 400 }, (_, index) => ({
			kind: "campaign",
			accountId: user.accountId,
			newsletterId: new mongoose.Types.ObjectId(),
			campaignId: new mongoose.Types.ObjectId(),
			contactId: new mongoose.Types.ObjectId(),
			email: `r${index}@watch.example.org`,
			status: index < 10 ? "bounced" : "delivered",
			sentAt: new Date(now - 3_600_000),
			...(index < 10 && { bouncedAt: new Date(now - 3_000_000) }),
		}));
		const messages = await m.Message.insertMany(docs);
		const result = await m.health.checkAccountHealth(user.accountId, { isUrgent: true });
		assert.deepEqual(result.watch, ["bounces"], "10 of 400, 2.5%");
		assert.equal((await load(user)).status, "active");
		assert.equal((await load(user)).watch.bounces.count, 10);

		await m.Message.updateMany({ accountId: user.accountId, _id: { $in: messages.slice(0, 4).map(({ _id }) => _id) } }, { $unset: { bouncedAt: 1 }, $set: { status: "delivered" } });
		const back = await m.health.checkAccountHealth(user.accountId, { isUrgent: true });
		assert.deepEqual(back.watch, [], "6 of 400, 1.5%");
		assert.equal((await load(user)).watch?.bounces, undefined);
	});

	test("an SES finding short of high impact warns, and its closing clears it", async () => {
		const user = await signIn("watch-ses@example.com");
		await m.Account.updateOne({ _id: user.accountId }, { $set: { "ses.tenantName": `mc-${user.accountId}` } });
		const event = (type, detail = {}) => ({
			source: "aws.ses",
			"detail-type": type,
			time: new Date().toISOString(),
			resources: [`arn:aws:ses:us-east-1:111122223333:tenant/mc-${user.accountId}/tn-0123`],
			detail,
		});
		const index = platformEmails.length;
		await m.tenantEvents.handleTenantEvent(event("Advisor Recommendation Status Open", { metadata: { impact: "LOW", type: "BOUNCE" } }));
		const account = await load(user);
		assert.equal(account.status, "active");
		assert.equal(account.watch.provider.detail, "SES finding: BOUNCE (low impact)");
		assert.ok(subjectsSince(index).includes("watch-ses@example.com [FlockStack] Our email provider flagged your sending"));

		await m.tenantEvents.handleTenantEvent(event("Advisor Recommendation Status Closed"));
		assert.equal((await load(user)).watch?.provider, undefined);
	});
});

describe("the dashboard banner", () => {
	const now = new Date("2026-10-19T12:00:00Z");
	const render = (account) => renderToStaticMarkup(BannerWatch({ account, now }));
	let BannerWatch;

	before(async () => {
		BannerWatch = (await import("../components/BannerWatch.jsx")).default;
	});

	test("shows each warning seen in the period with its numbers and the block level, and links what to do", () => {
		const account = {
			status: "active",
			watch: {
				bounces: { rate: 0.03, count: 30, sent: 1000, seenAt: new Date(now - DAY_MS) },
				gmail: { rate: 0.001, seenAt: new Date(now - 2 * DAY_MS) },
			},
		};
		const markup = render(account);
		assert.deepEqual([...markup.matchAll(/data-watch-issue="([^"]+)"/g)].map(([, issue]) => issue), ["bounces", "gmail"]);
		assert.match(markup, /Bounces are getting close to a block\.<\/span> 3\.00% of your emails bounced over the last 7 days\. The account is blocked at 5\.00% with 10 bounces\./);
		assert.match(markup, /Gmail&#x27;s spam rate is getting close to a block/);
		assert.match(markup, /Nothing is stopped yet\./);
		assert.match(markup, /href="\/docs\/warnings"/);
		assert.match(markup, /role="status"/);
	});

	test("shows nothing once the period is over, with no warning, or on a blocked account", () => {
		const old = { status: "active", watch: { bounces: { rate: 0.03, seenAt: new Date(now - (WATCH.periodDays + 1) * DAY_MS) } } };
		assert.equal(render(old), "");
		assert.equal(render({ status: "active" }), "");
		assert.equal(render({ status: "paused", watch: { bounces: { rate: 0.03, seenAt: now } } }), "", "BannerBlocked says more");
		assert.deepEqual(getActiveWatch({ status: "active", watch: { provider: { detail: "x", seenAt: now } } }, now).map(({ issue }) => issue), ["provider"]);
	});

	test("sits above every dashboard page", async () => {
		const source = await readFile(new URL("../components/LayoutDashboard.jsx", import.meta.url), "utf8");
		assert.match(source, /<BannerWatch account=\{account\} \/>\s*\{children\}/);
	});
});

describe("docs", () => {
	test("say that a spam trap blocks at once, with no warning, and give the levels the code uses", async () => {
		const { getWarningsGuide, getWarningsMarkdown } = await import("../lib/docs/warnings.js");
		const text = getWarningsGuide().flatMap(({ paragraphs }) => paragraphs).join(" ");
		assert.match(text, /One email to a trap blocks the account at once, with no warning first, by design/);
		assert.ok(text.includes(`more than ${Number((WATCH.bounceRate * 100).toFixed(2))}% of your emails hard bounce (at least ${WATCH.minBounces})`));
		assert.ok(text.includes(`once per issue every ${WATCH.periodDays} days`));
		assert.match(getWarningsMarkdown(), /### Spam traps block at once/);
		const { DOC_PAGES, getLlmsFull } = await import("../lib/docs/llms.js");
		assert.ok(DOC_PAGES.some(({ href }) => href === "/docs/warnings"));
		assert.match(getLlmsFull("http://localhost:3000"), /## Warnings and blocks/);
	});
});
