import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { anonymous, startTestApp } from "./helpers/app.mjs";
import { QSTASH_KEYS, act, createDraft, loadSendingModules, runJobs, sendRoutes, setupSender } from "./helpers/sending.mjs";
import { flushAfter } from "./stubs/next-server.mjs";

// Clicks per link (beehiiv parity N1): each tracked link carries its place in the email, a campaign keeps one row per
// link with its clicks, and each email remembers which links its reader clicked, so unique clicks and "who clicked"
// need no row per click.

const BASE = "https://mail.example.com";
const MESSAGE_ID = "66f1a2b3c4d5e6f7a8b9c0d1";
const CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/141.0 Safari/537.36";

const tokenOf = (url) => url.split("/").pop();

describe("click links with their place", () => {
	let tracking;

	before(async () => {
		process.env.BETTER_AUTH_SECRET ??= "test-session-secret-with-at-least-32-characters";
		tracking = await import("../lib/tracking.js");
	});

	test("carry the link's place under the signature; older links still read", () => {
		const url = "https://example.org/?a=1";
		const link = tracking.readClickToken(tokenOf(tracking.getClickUrl(BASE, MESSAGE_ID, url, 3)));
		assert.deepEqual(link, { messageId: MESSAGE_ID, url, link: 3, isSigned: true });

		const [id, signature, , encoded] = tokenOf(tracking.getClickUrl(BASE, MESSAGE_ID, url, 3)).split(".");
		assert.equal(tracking.readClickToken(`${id}.${signature}.4.${encoded}`).isSigned, false, "another place breaks the signature");
		assert.equal(tracking.readClickToken(`${id}.${signature}.${encoded}`).isSigned, false, "so does dropping it");

		const old = tracking.readClickToken(tokenOf(tracking.getClickUrl(BASE, MESSAGE_ID, url)));
		assert.deepEqual(old, { messageId: MESSAGE_ID, url, isSigned: true });
	});

	test("number the tracked links in order, skipping unsubscribe links, up to the cap", () => {
		const html = [
			'<p><a href="https://example.org/a">A</a>',
			'<a href="{{unsubscribe_url}}">Unsubscribe</a>',
			'<a href="https://mail.example.com/unsubscribe?token=x">Unsubscribe</a>',
			'<a href="https://example.org/a">A again</a>',
			'<a href="mailto:hi@example.com">Mail</a>',
			'<a href="https://example.org/b?x=1&amp;y=2">B</a></p>',
		].join("");
		const tracked = tracking.addTracking(html, { baseUrl: BASE, messageId: MESSAGE_ID });
		assert.deepEqual(tracking.readTrackedLinks(tracked), [
			{ index: 0, url: "https://example.org/a" },
			{ index: 1, url: "https://example.org/a" },
			{ index: 2, url: "https://example.org/b?x=1&y=2" },
		]);

		const many = Array.from({ length: tracking.MAX_TRACKED_LINKS + 5 }, (_, index) => `<a href="https://example.org/${index}">${index}</a>`).join("");
		const links = tracking.readTrackedLinks(tracking.addTracking(many, { baseUrl: BASE, messageId: MESSAGE_ID }));
		assert.equal(links.length, tracking.MAX_TRACKED_LINKS, "links past the cap are tracked without a place");
	});
});

describe("a campaign's clicks per link", () => {
	let app;
	let m;
	let user;
	let campaignId;

	const click = (url, userAgent = CHROME) =>
		anonymous(() => m.clickRoute.GET(new Request(url, { headers: { "user-agent": userAgent } }), { params: Promise.resolve({ token: tokenOf(url) }) }));

	async function linksOf(contactIndex) {
		const message = await m.Message.findOne({ accountId: user.accountId, campaignId, email: `reader${contactIndex}@clicks.example.org` }).lean();
		const { sent } = await import("./stubs/ses.mjs");
		const email = sent.findLast(({ to }) => to === message.email);
		const urls = [...email.html.matchAll(/href="([^"]+\/c\/[^"]+)"/g)].map(([, href]) => href);
		return { message, urls };
	}

	before(async () => {
		app = await startTestApp(QSTASH_KEYS);
		m = { ...(await loadSendingModules()), clickRoute: await import("../app/c/[token]/route.js"), CampaignLink: (await import("../models/CampaignLink.js")).default };
		user = await setupSender(m, "clicks@example.com", { contacts: 4 });
		campaignId = await createDraft(m, user, {
			subject: "Links",
			body: '<p><a href="https://example.org/one">One</a> and <a href="https://example.org/two">Two</a> and <a href="https://example.org/one">One again</a></p>',
		});
		await act(m, user, "send_campaign", { id: campaignId });
		await runJobs(sendRoutes(m));
		// Clicks seconds after the send look like a link scanner.
		await m.Message.updateMany({ accountId: user.accountId, campaignId }, { $set: { sentAt: new Date(Date.now() - 600_000) } });
	});

	after(() => app?.stop());

	test("the send stores each tracked link in order, a repeated link in each of its places", async () => {
		const rows = await m.CampaignLink.find({ accountId: user.accountId, campaignId }).sort({ index: 1 }).lean();
		assert.deepEqual(rows.map(({ index, url }) => [index, url]), [
			[0, "https://example.org/one"],
			[1, "https://example.org/two"],
			[2, "https://example.org/one"],
		]);
		assert.ok(rows.every(({ clicks, uniqueClicks }) => clicks === 0 && uniqueClicks === 0));
	});

	test("clicks count per link: unique once per reader, total every time, scanners never", async () => {
		const first = await linksOf(0);
		const second = await linksOf(1);
		assert.equal(first.urls.length, 3);
		for (const url of [first.urls[0], first.urls[0], first.urls[1], second.urls[0]]) assert.equal((await click(url)).status, 302);
		assert.equal((await click(second.urls[1], "Mimecast Link Checker")).status, 302);
		await flushAfter();

		const rows = await m.CampaignLink.find({ accountId: user.accountId, campaignId }).sort({ index: 1 }).lean();
		assert.deepEqual(rows.map(({ uniqueClicks, clicks }) => [uniqueClicks, clicks]), [[2, 3], [1, 1], [0, 0]]);
		const message = await m.Message.findOne({ accountId: user.accountId, _id: first.message._id }).lean();
		assert.deepEqual(message.clickedLinks, [0, 1]);
		const campaign = await m.Campaign.findOne({ accountId: user.accountId, _id: campaignId }).lean();
		assert.equal(campaign.stats.clicked, 2, "the campaign's unique clicks are unchanged");
	});

	test("the report lists the links with their rates, and who clicked one, a page at a time", async () => {
		const report = await act(m, user, "get_campaign_report", { id: campaignId });
		assert.equal(report.links.length, 3);
		assert.deepEqual(
			report.links.slice(0, 2).map(({ url, uniqueClicks, clicks, clickRate }) => ({ url, uniqueClicks, clicks, clickRate })),
			[
				{ url: "https://example.org/one", uniqueClicks: 2, clicks: 3, clickRate: 0.5 },
				{ url: "https://example.org/two", uniqueClicks: 1, clicks: 1, clickRate: 0.25 },
			]
		);

		const page = await act(m, user, "list_link_clicks", { id: campaignId, link: 0, limit: 1 });
		assert.equal(page.contacts.length, 1);
		assert.ok(page.nextCursor);
		const next = await act(m, user, "list_link_clicks", { id: campaignId, link: 0, limit: 1, cursor: page.nextCursor });
		assert.deepEqual([...page.contacts, ...next.contacts].map(({ email }) => email).sort(), ["reader0@clicks.example.org", "reader1@clicks.example.org"]);
		assert.equal(next.nextCursor, null);
		assert.deepEqual((await act(m, user, "list_link_clicks", { id: campaignId, link: 2 })).contacts, []);
		await assert.rejects(act(m, user, "list_link_clicks", { id: campaignId, link: 9 }), { code: "not_found" });
	});

	test("the click map is the email with each link's unique clicks on a badge, and no open pixel", async () => {
		const { getClickMapHtml, listCampaignLinks } = await import("../lib/link-clicks.js");
		const campaign = await m.Campaign.findOne({ accountId: user.accountId, _id: campaignId }).lean();
		const newsletter = await m.Newsletter.findOne({ accountId: user.accountId, _id: user.newsletterId }).lean();
		const html = await getClickMapHtml(campaign, newsletter, await listCampaignLinks(campaign));
		const badges = [...html.matchAll(/data-link="(\d+)">(\d+)<\/span>/g)].map(([, link, count]) => [Number(link), Number(count)]);
		assert.deepEqual(badges, [[0, 2], [1, 1], [2, 0]]);
		assert.ok(html.includes('href="https://example.org/two"'), "links lead to their real address");
		assert.doesNotMatch(html, /\/o\/|\/c\//);
	});

	test("old links without a place still count the click on the campaign", async () => {
		const { getClickUrl } = await import("../lib/tracking.js");
		const { message } = await linksOf(2);
		const url = getClickUrl("http://localhost:3000", message._id, "https://example.org/two");
		assert.equal((await click(url)).status, 302);
		await flushAfter();
		const stored = await m.Message.findOne({ accountId: user.accountId, _id: message._id }).lean();
		assert.ok(stored.clickedAt);
		assert.equal(stored.clickedLinks, undefined);
	});
});
