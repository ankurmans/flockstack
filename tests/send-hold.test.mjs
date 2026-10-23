import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { as, catchRedirect, form, signIn, startTestApp } from "./helpers/app.mjs";
import { QSTASH_KEYS, act, createDraft, loadSendingModules, runJobs, sendRoutes, setupSender } from "./helpers/sending.mjs";
import { published } from "./stubs/qstash.mjs";
import { sent as sesEmails } from "./stubs/ses.mjs";

// Undo send: the dashboard's Send holds the campaign for the newsletter's undo window, a job releases it, and undo and
// release meet on one row so exactly one of them wins.
let app;
let m;
let hold;

before(async () => {
	app = await startTestApp(QSTASH_KEYS);
	m = { ...(await loadSendingModules()), releaseRoute: await import("../app/api/jobs/release-held-send/route.js") };
	hold = await import("../lib/send-hold.js");
});

after(() => app?.stop());

const routes = () => sendRoutes(m, { "/api/jobs/release-held-send": m.releaseRoute });
const campaignOf = (user, id) => m.Campaign.findOne({ accountId: user.accountId, _id: id }).lean();
const usageOf = async (user) => (await m.Account.findById(user.accountId).lean()).usage.emailsSent;
const messagesOf = (user, id) => m.Message.countDocuments({ accountId: user.accountId, campaignId: id });
const releaseJobs = () => published.filter(({ url }) => url.endsWith("/api/jobs/release-held-send"));

async function newUser(email, options = {}) {
	const user = await setupSender(m, email, { contacts: 6, ...options });
	user.slug = email.split("@")[0];
	return user;
}

// The Send button of the dashboard.
const press = (user, id, options = {}) => as(user, () => m.campaigns.startSend(id, options));

// The job QStash would deliver at the hold's time, run now.
function releaseNow(user, id) {
	const job = releaseJobs().findLast(({ body }) => body.campaignId === id);
	return hold.runHeldRelease({ ...job.body, now: Date.now() + 60_000 });
}

describe("the dashboard's Send", () => {
	test("holds the send for the newsletter's undo window, with nothing queued, counted or emailed", async () => {
		const user = await newUser("hold-basic@example.com");
		const id = await createDraft(m, user, { subject: "Held" });
		const used = await usageOf(user);
		const before = sesEmails.length;
		const jobs = published.length;

		const result = await press(user, id);
		assert.equal(result.ok, true);
		assert.equal(result.status, "held");
		assert.equal(result.recipients, 6);
		const campaign = await campaignOf(user, id);
		assert.equal(campaign.status, "held");
		assert.ok(Math.abs(campaign.hold.sendAfter.getTime() - (Date.now() + 30_000)) < 5000, "30 seconds by default");
		assert.equal(await messagesOf(user, id), 0);
		assert.equal(await usageOf(user), used);
		assert.equal(sesEmails.length, before);

		const [job] = published.slice(jobs);
		assert.ok(job.url.endsWith("/api/jobs/release-held-send"));
		assert.equal(job.notBefore, Math.ceil(campaign.hold.sendAfter.getTime() / 1000));
		assert.equal(job.body.sendAfter, campaign.hold.sendAfter.toISOString());
	});

	test("is the newsletter's setting: off sends at once, 10 and 60 seconds hold that long", async () => {
		const user = await newUser("hold-setting@example.com");
		const set = (seconds) => act(m, user, "update_newsletter", { id: user.newsletterId, sendUndoSeconds: seconds });
		assert.equal((await set(10)).sendUndoSeconds, 10);
		const first = await createDraft(m, user);
		await press(user, first);
		const held = await campaignOf(user, first);
		assert.ok(Math.abs(held.hold.sendAfter.getTime() - (Date.now() + 10_000)) < 5000);
		await as(user, () => m.campaigns.sendCampaign(first, {}));

		await set(0);
		const second = await createDraft(m, user);
		const result = await press(user, second);
		assert.equal(result.status, "sending", "no wait");
		assert.equal((await campaignOf(user, second)).hold, undefined);
		await assert.rejects(set(45), { code: "validation_failed" });
		assert.equal((await set(60)).sendUndoSeconds, 60);
	});

	test("an API or MCP send is not held, and a web only issue publishes at once", async () => {
		const user = await newUser("hold-api@example.com");
		const id = await createDraft(m, user);
		const output = await act(m, user, "send_campaign", { id });
		assert.equal(output.status, "sending");
		assert.equal(output.hold, null);
		await act(m, user, "update_newsletter", { id: user.newsletterId, archiveEnabled: true });
		const web = await createDraft(m, user);
		await act(m, user, "update_campaign", { id: web, publishTo: "web" });
		assert.equal((await press(user, web)).status, "sent");
	});

	test("a scheduled campaign keeps its own time and is not held", async () => {
		const user = await newUser("hold-scheduled@example.com");
		const id = await createDraft(m, user);
		const at = new Date(Date.now() + 3_600_000).toISOString();
		await act(m, user, "schedule_campaign", { id, scheduledAt: at });
		const result = await press(user, id);
		assert.equal(result.status, "sending", "Send now on a scheduled issue goes at once");
		assert.equal((await campaignOf(user, id)).hold, undefined);
	});
});

describe("undo", () => {
	test("gives back the draft exactly as it was, and the release job then does nothing", async () => {
		const user = await newUser("undo-draft@example.com");
		const id = await createDraft(m, user, { subject: "Take it back", previewText: "Wait" });
		await as(user, () => m.campaigns.setCampaignAudience(id, "all"));
		const draft = await campaignOf(user, id);
		const used = await usageOf(user);
		const before = sesEmails.length;

		await press(user, id, { audienceLimit: 3 });
		assert.equal((await campaignOf(user, id)).audienceLimit, 3);
		assert.deepEqual(await as(user, () => m.campaigns.undoSend(id)), { ok: true });

		const after = await campaignOf(user, id);
		const { updatedAt: _a, ...restored } = after;
		const { updatedAt: _b, ...original } = draft;
		assert.deepEqual(restored, original);
		assert.equal(await messagesOf(user, id), 0);
		assert.equal(await usageOf(user), used);
		assert.equal(sesEmails.length, before);

		const [skipped] = await runJobs(routes(), { only: ({ url, body }) => url.endsWith("release-held-send") && body.campaignId === id });
		assert.equal(skipped?.result.skipped, "not held for this time anymore");
		assert.equal((await campaignOf(user, id)).status, "draft");
		assert.equal(await messagesOf(user, id), 0);
	});

	test("a second tab pressing Undo, or a click on an old bar, finds the draft and does no harm", async () => {
		const user = await newUser("undo-twice@example.com");
		const id = await createDraft(m, user);
		await press(user, id);
		assert.deepEqual(await as(user, () => m.campaigns.undoSend(id)), { ok: true });
		assert.deepEqual(await as(user, () => m.campaigns.undoSend(id)), { ok: true });
		assert.equal((await campaignOf(user, id)).status, "draft");
	});

	test("sending again after an undo holds again, and the earlier job stays harmless", async () => {
		const user = await newUser("undo-again@example.com");
		const id = await createDraft(m, user);
		await press(user, id);
		const first = releaseJobs().findLast(({ body }) => body.campaignId === id);
		await as(user, () => m.campaigns.undoSend(id));
		await new Promise((resolve) => setTimeout(resolve, 5));
		await press(user, id);
		assert.equal((await hold.runHeldRelease({ ...first.body, now: Date.now() + 60_000 })).skipped, "not held for this time anymore");
		assert.equal((await campaignOf(user, id)).status, "held");
		const result = await releaseNow(user, id);
		assert.equal(result.started, true);
		assert.equal((await campaignOf(user, id)).status, "sending");
	});

	test("can't edit, schedule or send twice while the send is held", async () => {
		const user = await newUser("undo-locked@example.com");
		const id = await createDraft(m, user);
		await press(user, id);
		await assert.rejects(act(m, user, "update_campaign", { id, subject: "Changed" }), { code: "conflict" });
		await assert.rejects(act(m, user, "schedule_campaign", { id, scheduledAt: new Date(Date.now() + 3_600_000).toISOString() }), { code: "conflict" });
		assert.equal((await press(user, id)).status, "held", "Send pressed twice keeps the undo window");
		const held = await act(m, user, "get_campaign", { id });
		assert.equal(held.status, "held");
		assert.equal(held.hold.recipients, 6);
		assert.equal(held.sendProblem, null);
	});
});

describe("release", () => {
	test("sends at the held time through the usual send, then undo is too late", async () => {
		const user = await newUser("release-ok@example.com");
		const id = await createDraft(m, user, { subject: "Goes out" });
		await press(user, id);
		const used = await usageOf(user);

		const early = await hold.runHeldRelease({ ...releaseJobs().findLast(({ body }) => body.campaignId === id).body, now: Date.now() });
		assert.equal(early.waiting, true, "a job that arrives early waits for its time");
		assert.equal((await campaignOf(user, id)).status, "held");

		assert.equal((await releaseNow(user, id)).started, true);
		await runJobs(routes());
		const campaign = await campaignOf(user, id);
		assert.equal(campaign.status, "sent");
		assert.equal(campaign.hold, undefined);
		assert.equal(campaign.stats.recipients, 6);
		assert.equal(await usageOf(user), used + 6);
		await assert.rejects(act(m, user, "undo_campaign_send", { id }), { code: "conflict" });
		assert.match((await as(user, () => m.campaigns.undoSend(id))).error, /already went out/);
	});

	test("Send now skips the wait, once", async () => {
		const user = await newUser("release-now@example.com");
		const id = await createDraft(m, user);
		await press(user, id);
		assert.deepEqual(await as(user, () => m.campaigns.sendCampaign(id, {})), { ok: true });
		assert.equal((await campaignOf(user, id)).status, "sending");
		const late = await releaseNow(user, id);
		assert.equal(late.skipped, "not held for this time anymore", "the job finds it gone");
		await runJobs(routes());
		assert.equal(await messagesOf(user, id), 6, "one email each");
		const again = await as(user, () => m.campaigns.sendCampaign(id, {}));
		assert.match(again.error, /already/);
	});

	test("a job delivered twice sends once", async () => {
		const user = await newUser("release-twice@example.com");
		const id = await createDraft(m, user);
		await press(user, id);
		const [one, two] = await Promise.all([releaseNow(user, id), releaseNow(user, id)]);
		assert.deepEqual([one, two].filter((result) => result.started).length, 1);
		assert.equal([one, two].filter((result) => result.skipped).length, 1);
		await runJobs(routes());
		assert.equal(await messagesOf(user, id), 6);
	});
});

describe("undo and release at the same instant", () => {
	async function hold1(email) {
		const user = await newUser(email, { contacts: 4 });
		const id = await createDraft(m, user);
		await press(user, id);
		const account = await m.Account.findById(user.accountId).lean();
		const campaign = await campaignOf(user, id);
		const undo = () => as(user, () => hold.undoHeldSend({ account, campaign })).then((result) => ({ undone: result.undone }), (error) => ({ tooLate: error.code }));
		return { user, id, undo, release: () => releaseNow(user, id) };
	}

	test("a release that claimed the send first wins, and undo is told it is too late", async () => {
		const { user, id, undo, release } = await hold1("race-release@example.com");
		const releasing = release();
		// The undo arrives while the release is working: the claim is already there.
		for (let wait = 0; wait < 500; wait++) {
			const current = await campaignOf(user, id);
			if (current.hold?.claimedAt || current.status !== "held") break;
			await new Promise((resolve) => setImmediate(resolve));
		}
		const undone = await undo();
		const released = await releasing;
		assert.equal(released.started, true);
		assert.deepEqual(undone, { tooLate: "conflict" });
		await runJobs(routes());
		assert.equal((await campaignOf(user, id)).status, "sent");
		assert.equal(await messagesOf(user, id), 4);
	});

	test("an undo that landed first wins, and the release does nothing", async () => {
		const { user, id, undo, release } = await hold1("race-undo@example.com");
		const [undone, released] = await Promise.all([undo(), release()]);
		assert.deepEqual(undone, { undone: true });
		assert.ok(released.skipped, "the release was told");
		await runJobs(routes());
		assert.equal((await campaignOf(user, id)).status, "draft");
		assert.equal(await messagesOf(user, id), 0, "nothing queued");
	});

	test("however they interleave there is exactly one outcome, never both and never neither", async () => {
		for (let round = 0; round < 12; round++) {
			const { user, id, undo, release } = await hold1(`race-${round}@example.com`);
			const ticks = round % 4;
			const delayed = (run) => async () => {
				for (let tick = 0; tick < ticks; tick++) await Promise.resolve();
				return run();
			};
			const runs = round % 2 ? [release, delayed(undo)] : [delayed(release), undo];
			const [one, two] = await Promise.all(runs.map((run) => run()));
			const released = [one, two].find((result) => "started" in result || "skipped" in result || "failed" in result);
			const undone = [one, two].find((result) => "undone" in result || "tooLate" in result);
			await runJobs(routes());

			const final = await campaignOf(user, id);
			if (released.started) {
				assert.deepEqual(undone, { tooLate: "conflict" });
				assert.equal(final.status, "sent");
				assert.equal(await messagesOf(user, id), 4);
			} else {
				assert.deepEqual(undone, { undone: true });
				assert.ok(released.skipped);
				assert.equal(final.status, "draft");
				assert.equal(await messagesOf(user, id), 0);
			}
		}
	});
});

describe("limits", () => {
	test("are checked when the send is held, so the writer hears at the click", async () => {
		const user = await newUser("limit-hold@example.com");
		await m.Account.updateOne({ _id: user.accountId }, { $set: { "usage.emailsSent": 99_998 } });
		const id = await createDraft(m, user);
		const result = await press(user, id);
		assert.match(result.error, /left|used up|limit/i);
		assert.equal((await campaignOf(user, id)).status, "draft");
		assert.equal(releaseJobs().filter(({ body }) => body.campaignId === id).length, 0, "no job for a send that wasn't held");
	});

	test("and again when it's released: a limit that passed meanwhile returns the draft and says so", async () => {
		const user = await newUser("limit-release@example.com");
		const id = await createDraft(m, user);
		await press(user, id);
		assert.equal((await campaignOf(user, id)).status, "held");
		await m.Account.updateOne({ _id: user.accountId }, { $set: { "usage.emailsSent": 99_998 } });

		const result = await releaseNow(user, id);
		assert.match(result.failed, /left|used up|limit|emails/i);
		const campaign = await campaignOf(user, id);
		assert.equal(campaign.status, "draft");
		assert.equal(campaign.hold, undefined);
		assert.equal(await messagesOf(user, id), 0);
	});

	test("the Free plan's cap on first campaigns is checked at the click, and again at release", async () => {
		const user = await signIn("limit-free@example.com");
		const url = await as(user, () => catchRedirect(m.newsletters.saveNewsletter(null, form({ name: "Free news", slug: "limit-free", postalAddress: "1 Main St, Paris" }))));
		Object.assign(user, { newsletterId: url.split("/").at(-1), slug: "limit-free" });
		const readers = (from, to) =>
			Array.from({ length: to - from }, (_, index) => ({ accountId: user.accountId, newsletterId: user.newsletterId, email: `reader${from + index}@limit-free.example.org`, status: "active", source: "import" }));
		await m.Contact.insertMany(readers(0, 501));
		const id = await createDraft(m, user);
		const refused = await press(user, id);
		assert.equal(refused.code, "plan_limit_emails");
		assert.match(refused.error, /500 people at most\. This one would go to 501\./);
		assert.equal((await campaignOf(user, id)).status, "draft");

		await m.Contact.deleteOne({ accountId: user.accountId, email: "reader0@limit-free.example.org" });
		assert.equal((await press(user, id)).status, "held");
		await m.Contact.insertMany(readers(600, 602));
		const result = await releaseNow(user, id);
		assert.match(result.failed, /500 people at most/);
		assert.equal((await campaignOf(user, id)).status, "draft");
		assert.equal(await messagesOf(user, id), 0);
	});
});

describe("the hourly sweep", () => {
	test("releases a held send whose job never ran, and leaves fresh holds alone", async () => {
		const user = await newUser("sweep-release@example.com");
		const stale = await createDraft(m, user);
		const fresh = await createDraft(m, user);
		await press(user, stale);
		await press(user, fresh);
		await m.Campaign.updateOne({ accountId: user.accountId, _id: stale }, { $set: { "hold.sendAfter": new Date(Date.now() - 10 * 60_000) } });

		const result = await hold.sweepHeldSends();
		assert.equal(result.released, 1);
		assert.equal((await campaignOf(user, stale)).status, "sending");
		assert.equal((await campaignOf(user, fresh)).status, "held");
		await runJobs(routes());
		assert.equal((await campaignOf(user, stale)).status, "sent");
		assert.equal(await messagesOf(user, stale), 6);
	});

	test("takes a release that died halfway again, without sending anyone twice", async () => {
		const user = await newUser("sweep-claimed@example.com");
		const id = await createDraft(m, user);
		await press(user, id);
		await m.Campaign.updateOne(
			{ accountId: user.accountId, _id: id },
			{ $set: { "hold.sendAfter": new Date(Date.now() - 10 * 60_000), "hold.claimedAt": new Date(Date.now() - 9 * 60_000) } }
		);
		assert.equal((await hold.sweepHeldSends()).released, 1);
		await runJobs(routes());
		assert.equal(await messagesOf(user, id), 6);
		assert.equal((await campaignOf(user, id)).status, "sent");
	});

	test("gives a draft back, with an alert, when the send can't start", async () => {
		const user = await newUser("sweep-revert@example.com");
		const id = await createDraft(m, user);
		await press(user, id);
		await m.Campaign.updateOne({ accountId: user.accountId, _id: id }, { $set: { "hold.sendAfter": new Date(Date.now() - 10 * 60_000) } });
		await m.Account.updateOne({ _id: user.accountId }, { $set: { "usage.emailsSent": 99_998 } });
		const result = await hold.sweepHeldSends();
		assert.equal(result.reverted, 1);
		assert.equal((await campaignOf(user, id)).status, "draft");
	});
});

describe("what the bar and the page show", () => {
	test("the bar's server actions list the held sends with the server's clock and give the countdown from it", async () => {
		const { getSecondsLeft } = await import("../lib/send-hold-rules.js");
		const user = await newUser("bar-list@example.com");
		const id = await createDraft(m, user, { subject: "Counting" });
		assert.deepEqual((await as(user, () => m.campaigns.listHeldSends())).holds, []);
		const started = await press(user, id);
		const { now, holds } = await as(user, () => m.campaigns.listHeldSends());
		assert.deepEqual(holds.map(({ id: one, subject, recipients }) => ({ id: one, subject, recipients })), [{ id, subject: "Counting", recipients: 6 }]);
		const seconds = getSecondsLeft(holds[0].sendAfter, new Date(now).getTime());
		assert.ok(seconds <= 30, `${seconds} s left, never more than the window`);
		assert.equal(getSecondsLeft(started.sendAfter, new Date(started.serverTime).getTime() + 31_000), 0, "never below zero");
		assert.equal(getSecondsLeft(holds[0].sendAfter, 0, new Date(now).getTime()), seconds, "a browser clock that is off counts from the server's");

		const other = await newUser("bar-other@example.com");
		assert.deepEqual((await as(other, () => m.campaigns.listHeldSends())).holds, [], "only the account's own");
		await as(user, () => m.campaigns.undoSend(id));
		assert.deepEqual((await as(user, () => m.campaigns.listHeldSends())).holds, []);
	});

	test("the campaign page of a held send says it is held and until when", async () => {
		const { createElement } = await import("react");
		const { renderToStaticMarkup } = await import("react-dom/server");
		const { TooltipProvider } = await import("../components/ui/tooltip.jsx");
		const page = (await import("../app/(app)/campaigns/[id]/page.js")).default;
		const user = await newUser("bar-page@example.com");
		const id = await createDraft(m, user, { subject: "On the page" });
		await press(user, id);
		const element = await as(user, () => page({ params: Promise.resolve({ id }) }));
		const html = renderToStaticMarkup(createElement(TooltipProvider, null, element)).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
		assert.match(html, /Held/);
		assert.match(html, /Held: this send waits until/);
		assert.match(html, /Nothing has been queued, counted or emailed yet/);
		await as(user, () => m.campaigns.undoSend(id));
	});
});
