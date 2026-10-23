import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { as, callApi, form, startTestApp } from "./helpers/app.mjs";
import { QSTASH_KEYS, act, createDraft, loadSendingModules, runJobs, sendRoutes, setupSender } from "./helpers/sending.mjs";

// The celebration after a send and the counters that follow it while it goes out.
let app;
let m;

before(async () => {
	app = await startTestApp(QSTASH_KEYS);
	m = { ...(await loadSendingModules()), apiKeys: await import("../app/(app)/api-keys/actions.js") };
});

after(() => app?.stop());

const text = (markup) => markup.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

describe("get_campaign_progress", () => {
	test("follows a send from the draft to sent, with the counters from the campaign's own aggregates", async () => {
		const user = await setupSender(m, "progress@example.com", { contacts: 5 });
		const id = await createDraft(m, user, { subject: "Progress" });
		const draft = await act(m, user, "get_campaign_progress", { id });
		assert.equal(draft.status, "draft");
		assert.equal(draft.isLive, false);
		assert.deepEqual(draft.counts, { recipients: 0, sent: 0, delivered: 0, opened: 0, clicked: 0, bounced: 0, unsubscribed: 0, complained: 0, failed: 0 });
		assert.equal(draft.hold, null);
		assert.ok(Math.abs(new Date(draft.serverTime).getTime() - Date.now()) < 5000);

		await as(user, () => m.campaigns.startSend(id));
		const held = await act(m, user, "get_campaign_progress", { id });
		assert.equal(held.status, "held");
		assert.equal(held.isLive, true);
		assert.equal(held.hold.recipients, 5);
		assert.equal(held.counts.recipients, 0, "nothing is queued while it is held");

		await as(user, () => m.campaigns.sendCampaign(id, {}));
		const sending = await act(m, user, "get_campaign_progress", { id });
		assert.equal(sending.status, "sending");
		assert.equal(sending.isLive, true);
		assert.equal(sending.counts.recipients, 5);
		assert.equal(sending.hold, null);

		await m.Campaign.updateOne({ accountId: user.accountId, _id: id }, { $set: { "stats.delivered": 4, "stats.opened": 2, "stats.clicked": 1, "stats.bounced": 1 } });
		await runJobs(sendRoutes(m));
		const sent = await act(m, user, "get_campaign_progress", { id });
		assert.equal(sent.status, "sent");
		assert.equal(sent.isLive, false, "the counters settle");
		assert.deepEqual([sent.counts.sent, sent.counts.opened, sent.counts.clicked, sent.counts.bounced], [5, 2, 1, 1]);
		assert.ok(sent.sentAt);
	});

	test("is a read action, in the REST API, for the account's own campaigns", async () => {
		const { getActionClass } = await import("../lib/action-scopes.js");
		assert.equal(getActionClass("get_campaign_progress"), "read");
		const user = await setupSender(m, "progress-api@example.com", { contacts: 2 });
		const other = await setupSender(m, "progress-other@example.com", { contacts: 2 });
		const id = await createDraft(m, user, { subject: "Mine" });
		const key = (await as(user, () => m.apiKeys.createApiKey(null, form({ name: "Reader", level: "read_only" })))).key;
		const response = await callApi("GET", `/api/v1/campaigns/${id}/progress`, { key });
		assert.equal(response.status, 200);
		assert.equal(response.body.id, id);
		const otherKey = (await as(other, () => m.apiKeys.createApiKey(null, form({ name: "Reader", level: "read_only" })))).key;
		assert.equal((await callApi("GET", `/api/v1/campaigns/${id}/progress`, { key: otherKey })).status, 404);
	});
});

describe("the bar", () => {
	test("counts down to the send and offers Undo and Send now, then says it is going out", async () => {
		const { RowHold } = await import("../components/BarSend.jsx");
		const hold = { id: "c1", subject: "Hello", sendAfter: new Date().toISOString(), recipients: 4812 };
		const counting = renderToStaticMarkup(createElement(RowHold, { hold, seconds: 28, isBusy: false, onUndo() {}, onSendNow() {} }));
		assert.match(text(counting), /Sending to 4,812 readers in 28 s\./);
		assert.match(counting, /Undo/);
		assert.match(counting, /Send now/);
		const going = renderToStaticMarkup(createElement(RowHold, { hold, seconds: 0, isBusy: false, onUndo() {}, onSendNow() {} }));
		assert.match(text(going), /Sending to 4,812 readers…/);
		assert.match(going, /disabled=""[^>]*>Send now/, "Send now has nothing left to skip");
		assert.match(text(renderToStaticMarkup(createElement(RowHold, { hold: { ...hold, recipients: 1 }, seconds: 5 }))), /Sending to 1 reader in 5 s\./);
	});

	test("celebrates with the number it went to, a link to the results, and only with motion when motion is welcome", async () => {
		const { RowSent } = await import("../components/BarSend.jsx");
		const html = renderToStaticMarkup(createElement(RowSent, { recipients: 4812, campaignId: "c1", onClose() {} }));
		assert.match(text(html), /Sent to 4,812 readers\./);
		assert.match(html, /href="\/campaigns\/c1"/);
		assert.match(html, /aria-label="Close"/);
		for (const animation of html.match(/[a-z-]*:?animate-\[[^\]]+\]/g)) assert.match(animation, /^motion-safe:/, `${animation} waits for motion-safe`);
		assert.match(text(renderToStaticMarkup(createElement(RowSent, { recipients: 0, campaignId: "c1" }))), /Published on your website\./);
		const css = await (await import("node:fs/promises")).readFile(new URL("../app/globals.css", import.meta.url), "utf8");
		assert.match(css, /@keyframes celebrate-ring/);
		assert.match(css, /@keyframes celebrate-check/);
	});
});

describe("the numbers on a campaign's page", () => {
	test("show the counters from the server's reading, with a live mark while it sends and a done mark just after", async () => {
		const { default: LiveResults } = await import("../components/LiveResults.jsx");
		const counts = { recipients: 100, sent: 40, delivered: 30, opened: 10, clicked: 5, bounced: 1, unsubscribed: 0, complained: 0, failed: 0 };
		const render = (initial) => text(renderToStaticMarkup(createElement(LiveResults, { campaignId: "c1", initial: { counts, ...initial } })));
		const live = render({ status: "sending", isLive: true, watch: true });
		assert.match(live, /40 of 100/);
		assert.match(live, /Live/);
		assert.match(live, /40%/);
		assert.match(live, /Delivered 75\.0% 30/);
		assert.match(live, /Opened 33\.3% 10/);
		const done = render({ status: "sent", isLive: false, watch: true });
		assert.match(done, /Done/);
		assert.doesNotMatch(render({ status: "sent", isLive: false, watch: false }), /of 100|Done|Live/, "an old send is the numbers alone");
	});

	test("the report page gives a sending campaign its counters, and the held one its note", async () => {
		const page = (await import("../app/(app)/campaigns/[id]/page.js")).default;
		const { TooltipProvider } = await import("../components/ui/tooltip.jsx");
		const user = await setupSender(m, "progress-page@example.com", { contacts: 4 });
		const id = await createDraft(m, user, { subject: "On the page" });
		await act(m, user, "send_campaign", { id });
		const element = await as(user, () => page({ params: Promise.resolve({ id }) }));
		const html = text(renderToStaticMarkup(createElement(TooltipProvider, null, element)));
		assert.match(html, /0 of 4/);
		assert.match(html, /Live/);
		assert.match(html, /Delivered/);
	});
});
