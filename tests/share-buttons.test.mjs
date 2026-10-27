import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { startTestApp } from "./helpers/app.mjs";
import { decodeClickLinks } from "./helpers/links.mjs";
import { QSTASH_KEYS, act, createDraft, loadSendingModules, runJobs, sendRoutes, setupSender } from "./helpers/sending.mjs";
import { sent } from "./stubs/ses.mjs";
import { SHARE_HOSTS, areShareButtonsOn, getShareLinks } from "../lib/share-links.js";
import { renderEmail } from "../lib/render-email.js";
import { buildRecipientEmail } from "../lib/sending-rules.js";

// Share buttons in the email header (parity item S4): plain links to the issue's web page, off unless asked for, the issue's
// own word over the newsletter's.
let app;
let m;

before(async () => {
	app = await startTestApp(QSTASH_KEYS);
	m = await loadSendingModules();
});

after(() => app?.stop());

const newsletter = { _id: "74f1a2b3c4d5e6f7a8b9c0d2", name: "Field notes", slug: "field-notes", fromEmail: "jane@example.net", postalAddress: "1 Main St, Paris", archiveEnabled: true };
const campaign = { _id: "84f1a2b3c4d5e6f7a8b9c0d3", format: "rich", subject: "Issue 12 & more", html: "<p>Hello <a href=\"https://shop.example.com/x\">shop</a></p>", archiveSlug: "issue-12" };
const contact = { _id: "64f1a2b3c4d5e6f7a8b9c0d1", email: "reader@example.com" };

describe("the links", () => {
	test("share the page's address and the subject through each network's own sharing address", () => {
		const links = getShareLinks({ url: "https://news.example.com/p/issue-12?a=1&b=2", title: "Issue 12 & more" });
		assert.deepEqual(links.map(({ id }) => id), ["x", "linkedin", "facebook", "email"]);
		const url = encodeURIComponent("https://news.example.com/p/issue-12?a=1&b=2");
		assert.equal(links[0].href, `https://twitter.com/intent/tweet?url=${url}&text=${encodeURIComponent("Issue 12 & more")}`);
		assert.equal(links[1].href, `https://www.linkedin.com/sharing/share-offsite/?url=${url}`);
		assert.equal(links[2].href, `https://www.facebook.com/sharer/sharer.php?u=${url}`);
		assert.equal(links[3].href, `mailto:?subject=${encodeURIComponent("Issue 12 & more")}&body=${url}`);
		assert.deepEqual(getShareLinks({ url: "" }), []);
		assert.deepEqual(getShareLinks({ url: null }), []);
	});

	test("an issue's own word wins over the newsletter's, and the default is off", () => {
		assert.equal(areShareButtonsOn({}, {}), false);
		assert.equal(areShareButtonsOn({ shareButtons: true }, {}), true);
		assert.equal(areShareButtonsOn({ shareButtons: true }, { shareButtons: false }), false);
		assert.equal(areShareButtonsOn({ shareButtons: false }, { shareButtons: true }), true);
		assert.equal(areShareButtonsOn(null, null), false);
	});
});

describe("an email", () => {
	const build = (settings = {}, issue = {}) => buildRecipientEmail({ campaign: { ...campaign, ...issue }, newsletter: { ...newsletter, ...settings }, contact, messageId: "6650f1c2e9b1d4a0123456aa" });

	test("has them beside Read online when the newsletter turns them on", () => {
		const off = build();
		assert.ok(!off.html.includes("Share:"));
		const on = build({ shareButtons: true });
		assert.match(on.html, /Share:<\/span> <a [^>]*>X<\/a> · <a [^>]*>LinkedIn<\/a> · <a [^>]*>Facebook<\/a> · <a [^>]*>Email<\/a> &nbsp;\|&nbsp; <a [^>]*>Read online<\/a>/);
		const shared = decodeClickLinks(on.html);
		const page = "https://field-notes.flockstackmail.com/p/issue-12";
		assert.ok(shared.some((url) => url.startsWith("https://twitter.com/intent/tweet?") && url.includes(encodeURIComponent(page))), shared.join("\n"));
		assert.ok(shared.some((url) => url.startsWith("https://www.linkedin.com/sharing/share-offsite/?url=")));
		assert.ok(shared.some((url) => url.startsWith("mailto:?subject=")), "the mailto link is left as it is");
		assert.ok(on.html.indexOf("Share:") < on.html.indexOf("Read online"));
	});

	test("follow the issue's own setting, either way", () => {
		assert.ok(build({ shareButtons: true }, { shareButtons: false }).html.indexOf("Share:") === -1);
		assert.ok(build({}, { shareButtons: true }).html.includes("Share:"));
	});

	test("need the issue's page: none for a website that is off, an unlisted or paid issue, or a transactional email", () => {
		assert.ok(!build({ shareButtons: true, archiveEnabled: false }).html.includes("Share:"));
		assert.ok(!build({ shareButtons: true }, { archiveListed: false }).html.includes("Share:"));
		assert.ok(!build({ shareButtons: true }, { audience: "paid" }).html.includes("Share:"));
		const receipt = buildRecipientEmail({ campaign, newsletter: { ...newsletter, shareButtons: true }, contact, messageId: "6650f1c2e9b1d4a0123456aa", transactionalReason: "You bought a thing" });
		assert.ok(!receipt.html.includes("Share:"));
	});

	test("are in a designed HTML issue too, above it with the read online link", () => {
		const html = build({ shareButtons: true }, { format: "html", html: "<html><body><p>Designed</p></body></html>" }).html;
		assert.match(html, /<body>[^]*Share:[^]*Read online[^]*Designed/);
	});

	test("leave the share form alone when links get UTM tags, and tag the writer's own links", () => {
		const links = decodeClickLinks(build({ shareButtons: true, utmLinks: true }).html);
		const twitter = links.find((url) => url.startsWith("https://twitter.com/intent/tweet"));
		assert.ok(twitter && !twitter.includes("utm_"), twitter);
		assert.ok(links.some((url) => url.startsWith("https://shop.example.com/x?utm_source=")), "other links are still tagged");
		for (const host of SHARE_HOSTS) assert.ok(links.every((url) => !url.includes(`${host}`) || !url.includes("utm_")));
	});

	test("are not on the web version of an issue, and are in the label of the reader's language", () => {
		const page = renderEmail({ format: "rich", html: campaign.html, subject: "S", newsletter, isWebVersion: true, shareLinks: getShareLinks({ url: "https://x.example/p/a" }) });
		assert.ok(!page.html.includes("Share"));
		const spanish = renderEmail({ format: "rich", html: campaign.html, subject: "S", newsletter: { ...newsletter, language: "es" }, webUrl: "https://x.example/p/a", shareLinks: getShareLinks({ url: "https://x.example/p/a" }) });
		assert.match(spanish.html, /Compartir:/);
	});
});

describe("the settings", () => {
	test("a newsletter saves the switch through update_newsletter, and an issue its own word through update_campaign", async () => {
		const user = await setupSender(m, "share-settings@example.com", { contacts: 1 });
		assert.equal((await act(m, user, "get_newsletter", { id: user.newsletterId })).shareButtons, false);
		assert.equal((await act(m, user, "update_newsletter", { id: user.newsletterId, shareButtons: true })).shareButtons, true);
		assert.equal((await act(m, user, "update_newsletter", { id: user.newsletterId, replyTo: "hi@example.com" })).shareButtons, true, "other changes keep it");

		const id = await createDraft(m, user, { subject: "Share me" });
		assert.equal((await act(m, user, "get_campaign", { id })).shareButtons, null, "follows the newsletter");
		assert.equal((await act(m, user, "update_campaign", { id, shareButtons: false })).shareButtons, false);
		assert.equal((await act(m, user, "duplicate_campaign", { id })).shareButtons, false);
		assert.equal((await act(m, user, "update_campaign", { id, shareButtons: true })).shareButtons, true);
		assert.equal((await act(m, user, "update_campaign", { id, shareButtons: null })).shareButtons, null);
		const created = await act(m, user, "create_campaign", { subject: "Created", shareButtons: true, content: "Hi" });
		assert.equal(created.shareButtons, true);
	});

	test("the dashboard's choice saves true, false and back to the newsletter's", async () => {
		const user = await setupSender(m, "share-dashboard@example.com", { contacts: 1 });
		const id = await createDraft(m, user);
		const { as } = await import("./helpers/app.mjs");
		const actions = await import("../app/(app)/campaigns/actions.js");
		const stored = async () => (await m.Campaign.findOne({ accountId: user.accountId, _id: id }).lean()).shareButtons;
		assert.deepEqual(await as(user, () => actions.setCampaignShareButtons(id, true)), { ok: true });
		assert.equal(await stored(), true);
		await as(user, () => actions.setCampaignShareButtons(id, false));
		assert.equal(await stored(), false);
		await as(user, () => actions.setCampaignShareButtons(id, null));
		assert.equal(await stored(), undefined);
	});
});

describe("a send", () => {
	test("goes out with the share links in the header", async () => {
		const user = await setupSender(m, "share-send@example.com", { contacts: 1 });
		await m.Newsletter.updateOne({ accountId: user.accountId, _id: user.newsletterId }, { $set: { archiveEnabled: true } });
		await act(m, user, "update_newsletter", { id: user.newsletterId, shareButtons: true });
		const id = await createDraft(m, user, { subject: "Shared issue" });
		await act(m, user, "send_campaign", { id });
		await runJobs(sendRoutes(m));
		const email = sent.findLast(({ to }) => to === "reader0@share-send.example.org");
		assert.ok(email.html.includes("Share:"));
		assert.ok(decodeClickLinks(email.html).some((url) => url.startsWith("https://www.facebook.com/sharer/sharer.php?u=")));
	});
});
