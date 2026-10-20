import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { activate, as, catchNotFound, catchRedirect, form, signIn, startTestApp } from "./helpers/app.mjs";
import { addIssue } from "./helpers/community.mjs";

// The dashboard side of the website: the brand section in Settings with its live preview, the Website page with the pages,
// the navigation and the tags, and the tags on an issue. Each action goes through the registry (tests/parity.test.mjs).
let app;
let m;
let counter = 0;

before(async () => {
	app = await startTestApp();
	m = {
		newsletters: await import("../app/(app)/newsletters/actions.js"),
		settingsPage: (await import("../app/(app)/newsletters/page.js")).default,
		website: await import("../app/(app)/website/actions.js"),
		websitePage: (await import("../app/(app)/website/page.js")).default,
		pageEditor: (await import("../app/(app)/website/pages/[id]/page.js")).default,
		campaigns: await import("../app/(app)/campaigns/actions.js"),
		TooltipProvider: (await import("../components/ui/tooltip.jsx")).TooltipProvider,
		Newsletter: (await import("../models/Newsletter.js")).default,
		SitePage: (await import("../models/SitePage.js")).default,
		Campaign: (await import("../models/Campaign.js")).default,
	};
});

after(() => app?.stop());

async function owner() {
	const user = await signIn(`dash${++counter}@example.com`);
	await activate(user);
	user.slug = `dash${counter}`;
	const url = await as(user, () =>
		catchRedirect(m.newsletters.saveNewsletter(null, form({ name: `${user.slug} news`, slug: user.slug, fromEmail: `hello@${user.slug}.flockstackmail.com`, postalAddress: "1 Main St, Paris", archiveEnabled: "on" })))
	);
	user.newsletterId = url.split("/").at(-1);
	return user;
}

const render = (element) => renderToStaticMarkup(createElement(m.TooltipProvider, null, element));
const saved = (user) => m.Newsletter.findOne({ accountId: user.accountId, _id: user.newsletterId }).lean();

describe("the brand in Settings", () => {
	test("shows the accent, four themes, four font pairs, the header image, the email header switch and a preview", async () => {
		const user = await owner();
		const markup = render(await as(user, () => m.settingsPage()));
		assert.match(markup, /<h2[^>]*>Brand<\/h2>/);
		for (const label of ["Classic", "Magazine", "Minimal", "Bold", "Sans", "Serif", "Editorial", "Modern"]) assert.match(markup, new RegExp(`>${label}<`), label);
		assert.match(markup, /<input type="hidden" name="theme" value="classic"\/>/);
		assert.match(markup, /<input type="hidden" name="fontPair" value="sans"\/>/);
		assert.match(markup, /name="accentColor"/);
		assert.match(markup, /name="headerUrl"/);
		assert.match(markup, /name="emailLogo"/);
		assert.match(markup, /role="radiogroup" aria-label="Theme"/);
		assert.match(markup, /role="tab"[^>]*aria-selected="true"[^>]*>Website<\/button>/, "the website preview");
		assert.match(markup, /data-site-theme="classic"/, "drawn in the chosen theme");
		assert.match(markup, /Subscribe/);
	});

	test("saves the theme, the fonts, the header and the email logo with the rest of the settings", async () => {
		const user = await owner();
		const fields = { id: user.newsletterId, name: "Brand notes", slug: user.slug, fromEmail: `hello@${user.slug}.flockstackmail.com`, postalAddress: "1 Main St, Paris", archiveEnabled: "on" };
		const result = await as(user, () => m.newsletters.saveNewsletter(null, form({ ...fields, accentColor: "#1d4ed8", theme: "bold", fontPair: "serif", headerUrl: "https://cdn.example.com/h.jpg", emailLogo: "on" })));
		assert.equal(result.ok, true, JSON.stringify(result));
		const stored = await saved(user);
		assert.deepEqual(stored.brand, { theme: "bold", fontPair: "serif", headerUrl: "https://cdn.example.com/h.jpg", emailLogo: true });
		assert.equal(stored.accentColor, "#1d4ed8");

		const markup = render(await as(user, () => m.settingsPage()));
		assert.match(markup, /<input type="hidden" name="theme" value="bold"\/>/);
		assert.match(markup, /aria-checked="true"[^>]*><span[^>]*>Bold</);
		assert.match(markup, /--site-font-body:Georgia/, "the preview wears the saved fonts");

		const back = await as(user, () => m.newsletters.saveNewsletter(null, form({ ...fields, theme: "classic", fontPair: "sans", headerUrl: "" })));
		assert.equal(back.ok, true);
		assert.deepEqual((await saved(user)).brand, { theme: "classic", fontPair: "sans", emailLogo: false }, "back to the defaults, with the empty header left out");
	});

	test("refuses a header that isn't an https address, and says why", async () => {
		const user = await owner();
		const result = await as(user, () =>
			m.newsletters.saveNewsletter(null, form({ id: user.newsletterId, name: "Bad", slug: user.slug, fromEmail: `hello@${user.slug}.flockstackmail.com`, postalAddress: "1 Main St", headerUrl: "http://cdn.example.com/h.jpg" }))
		);
		assert.match(result.error, /https/);
	});
});

describe("the Website page", () => {
	test("starts a page from a title, opens it in the editor, saves it and publishes it", async () => {
		const user = await owner();
		const empty = render(await as(user, () => m.websitePage()));
		assert.match(empty, /<h2[^>]*>Pages<\/h2>/);
		assert.match(empty, /Pages like About, Sponsor or Contact/);
		assert.match(empty, /<h2[^>]*>Navigation<\/h2>/);
		assert.match(empty, /<h2[^>]*>Tags<\/h2>/);

		const url = await as(user, () => catchRedirect(m.website.createPage(user.newsletterId, "About me")));
		const id = url.split("/").at(-1);
		assert.match(url, /^\/website\/pages\/[a-f0-9]{24}$/);
		assert.equal((await m.SitePage.findOne({ accountId: user.accountId, _id: id }).lean()).status, "draft");

		const editor = render(await as(user, () => m.pageEditor({ params: Promise.resolve({ id }) })));
		assert.match(editor, /value="About me"/);
		assert.match(editor, /value="about-me"/);
		assert.match(editor, /A draft: only you see it/);

		const result = await as(user, () => m.website.savePage(id, { title: "About me", slug: "about", description: "Who I am", content: "<p>Hello <strong>there</strong></p><script>x</script>", status: "published" }));
		assert.equal(result.ok, true, JSON.stringify(result));
		const stored = await m.SitePage.findOne({ accountId: user.accountId, _id: id }).lean();
		assert.deepEqual([stored.slug, stored.status, stored.description, stored.html], ["about", "published", "Who I am", "<p>Hello <strong>there</strong></p>"]);
		assert.match(render(await as(user, () => m.websitePage())), /\/p\/about/);

		const clash = await as(user, () => m.website.savePage(id, { title: "About me", slug: "", content: "x", status: "draft" }));
		assert.match(clash.error, /slug/);
	});

	test("refuses a slug an issue uses, and one page can't take another's", async () => {
		const user = await owner();
		await addIssue({ Campaign: m.Campaign }, { accountId: user.accountId, newsletterId: user.newsletterId }, { subject: "Taken", archiveSlug: "taken" });
		const first = (await as(user, () => catchRedirect(m.website.createPage(user.newsletterId, "First")))).split("/").at(-1);
		const second = (await as(user, () => catchRedirect(m.website.createPage(user.newsletterId, "Second")))).split("/").at(-1);
		assert.match((await as(user, () => m.website.savePage(first, { title: "First", slug: "taken", content: "", status: "draft" }))).error, /already uses this slug/);
		assert.match((await as(user, () => m.website.savePage(second, { title: "Second", slug: "first", content: "", status: "draft" }))).error, /already uses this slug/);
	});

	test("saves the navigation, shows it again, and deleting a page takes it out", async () => {
		const user = await owner();
		const id = (await as(user, () => catchRedirect(m.website.createPage(user.newsletterId, "Sponsor")))).split("/").at(-1);
		const result = await as(user, () =>
			m.website.saveNavigation(user.newsletterId, [
				{ kind: "page", page: id },
				{ kind: "archive", label: "Back issues" },
				{ kind: "link", label: "Podcast", url: "https://example.com/podcast" },
			])
		);
		assert.equal(result.ok, true, JSON.stringify(result));
		assert.deepEqual(result.items.map(({ kind, label, text }) => [kind, label, text]), [["page", "", "Sponsor"], ["archive", "Back issues", "Back issues"], ["link", "Podcast", "Podcast"]]);
		const markup = render(await as(user, () => m.websitePage()));
		assert.match(markup, /aria-label="Link 1 type"/);
		assert.match(markup, /value="https:\/\/example\.com\/podcast"/);
		assert.match(markup, /value="Back issues"/);

		assert.match((await as(user, () => m.website.saveNavigation(user.newsletterId, [{ kind: "link", label: "Plain", url: "http://example.com" }]))).error, /https/);
		const where = await as(user, () => catchRedirect(m.website.deletePage(id)));
		assert.equal(where, "/website");
		assert.deepEqual((await saved(user)).navigation.map(({ kind }) => kind), ["archive", "link"]);
	});

	test("opens only the account's own pages", async () => {
		const user = await owner();
		const other = await owner();
		const id = (await as(user, () => catchRedirect(m.website.createPage(user.newsletterId, "Mine")))).split("/").at(-1);
		assert.equal(await as(other, () => catchNotFound(m.pageEditor({ params: Promise.resolve({ id }) }))), true);
		assert.equal(await as(other, () => catchNotFound(m.pageEditor({ params: Promise.resolve({ id: "not-an-id" }) }))), true);
		assert.match((await as(other, () => m.website.savePage(id, { title: "Hijacked", slug: "mine", content: "", status: "published" }))).error, /not found/i);
		assert.equal((await m.SitePage.findOne({ accountId: user.accountId, _id: id }).lean()).title, "Mine");
	});

	test("lists the tags in use with their issue counts", async () => {
		const user = await owner();
		const issue = await addIssue({ Campaign: m.Campaign }, { accountId: user.accountId, newsletterId: user.newsletterId }, { subject: "Tagged", archiveSlug: "tagged" });
		await as(user, () => m.campaigns.setCampaignTags(String(issue._id), "Interviews, tools"));
		const markup = render(await as(user, () => m.websitePage()));
		assert.match(markup, /interviews<\/span>/);
		assert.match(markup, /1 issue/);
	});
});

describe("tags on an issue", () => {
	test("save as typed, normalized, and say what is wrong with one that isn't a tag", async () => {
		const user = await owner();
		const issue = await addIssue({ Campaign: m.Campaign }, { accountId: user.accountId, newsletterId: user.newsletterId }, { subject: "Tagged", archiveSlug: "tagged-one" });
		const ok = await as(user, () => m.campaigns.setCampaignTags(String(issue._id), "Interviews,  tools & tips , interviews"));
		assert.deepEqual(ok, { ok: true, tags: ["interviews", "tools & tips"] });
		assert.deepEqual((await m.Campaign.findOne({ accountId: user.accountId, _id: issue._id }).lean()).tagSlugs, ["interviews", "tools-tips"]);
		assert.match((await as(user, () => m.campaigns.setCampaignTags(String(issue._id), "<script>"))).error, /isn't a valid tag/);
		assert.deepEqual(await as(user, () => m.campaigns.setCampaignTags(String(issue._id), "")), { ok: true, tags: [] });
	});
});
