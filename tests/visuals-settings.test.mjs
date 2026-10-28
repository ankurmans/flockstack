import assert from "node:assert/strict";
import crypto from "node:crypto";
import { after, before, describe, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { activate, as, callApi, form, signIn, startTestApp } from "./helpers/app.mjs";
import { SECTION_ICON_KEYS } from "../lib/briefing-rules.js";
import { isIssueCardOn } from "../lib/issue-card-rules.js";

// The settings half of docs/VISUALS-DESIGN.md: the publisher line, the issue card switch (newsletter and issue), the grotesk font
// pair and section icons through the API, MCP and the dashboard alike; the shared empty state and the owner's link previews.
let app;
let counter = 0;

before(async () => {
	app = await startTestApp({ CREDENTIALS_ENCRYPTION_KEY: crypto.randomBytes(32).toString("base64") });
});

after(() => app?.stop());

async function customer() {
	const user = await signIn(`visuals${++counter}@example.com`);
	await activate(user);
	const { createApiKey } = await import("../app/(app)/api-keys/actions.js");
	user.key = (await as(user, () => createApiKey(null, form({ name: "Agent", level: "full" })))).key;
	const created = await callApi("POST", "/api/v1/newsletters", { key: user.key, body: { name: `Visual notes ${counter}` } });
	assert.equal(created.status, 201, JSON.stringify(created.body));
	user.newsletter = created.body;
	return user;
}

const api = (user, method, path, body) => callApi(method, `/api/v1${path}`, { key: user.key, body });
const patchBrand = (user, brand) => api(user, "PATCH", `/newsletters/${user.newsletter.slug}`, { brand });

describe("the publisher line", () => {
	test("is plain text on one line, 60 characters at most, kept by other changes and removed when empty", async () => {
		const user = await customer();
		assert.equal(user.newsletter.brand.publisher, "", "none at first");
		const saved = await patchBrand(user, { publisher: "  by   Example\nMedia " });
		assert.equal(saved.status, 200, JSON.stringify(saved.body));
		assert.equal(saved.body.brand.publisher, "by Example Media");
		assert.equal((await patchBrand(user, { emailLogo: true })).body.brand.publisher, "by Example Media", "a change to another brand field keeps it");
		assert.equal((await api(user, "GET", `/newsletters/${user.newsletter.slug}`)).body.brand.publisher, "by Example Media");
		const [listed] = (await api(user, "GET", "/newsletters")).body.newsletters.filter(({ id }) => id === user.newsletter.id);
		assert.equal(listed.brand.publisher, "by Example Media", "list_newsletters shows it too");

		assert.equal((await patchBrand(user, { publisher: "x".repeat(60) })).status, 200);
		const tooLong = await patchBrand(user, { publisher: "x".repeat(61) });
		assert.equal(tooLong.status, 400);
		assert.equal(tooLong.body.error.code, "validation_failed");

		assert.equal((await patchBrand(user, { publisher: "" })).body.brand.publisher, "");
		const stored = await (await import("../models/Newsletter.js")).default.findOne({ accountId: user.accountId, _id: user.newsletter.id }).lean();
		assert.equal(stored.brand.publisher, undefined, "empty is not stored");
	});

	test("is set at creation too", async () => {
		const user = await customer();
		const created = await api(user, "POST", "/newsletters", { name: "Second visual notes", brand: { publisher: "by Example Media", fontPair: "grotesk" } });
		assert.equal(created.status, 201, JSON.stringify(created.body));
		assert.deepEqual([created.body.brand.publisher, created.body.brand.fontPair], ["by Example Media", "grotesk"]);
	});
});

describe("the grotesk font pair", () => {
	test("saves through the API and the settings form, which says its web fonts are for the website", async () => {
		const user = await customer();
		assert.equal((await patchBrand(user, { fontPair: "grotesk" })).body.brand.fontPair, "grotesk");
		assert.equal((await patchBrand(user, { fontPair: "comic" })).status, 400);
		const page = await as(user, () => import("../app/(app)/newsletters/page.js").then(({ default: render }) => render()));
		const { TooltipProvider } = await import("../components/ui/tooltip.jsx");
		const html = renderToStaticMarkup(createElement(TooltipProvider, null, page));
		assert.match(html, /<input type="hidden" name="fontPair" value="grotesk"\/>/);
		assert.match(html, />Grotesk</);
		assert.match(html, /web fonts show on the website only/);
	});

	test("is listed in the font pair's description for agents", async () => {
		const { getAction } = await import("../lib/actions/registry.js");
		const { toJsonSchema } = await import("../lib/docs/reference.js");
		const { properties } = toJsonSchema(getAction("update_newsletter").input, "input");
		assert.ok(properties.brand.properties.fontPair.enum.includes("grotesk"));
		assert.match(properties.brand.properties.fontPair.description, /grotesk.*website only/);
		for (const field of ["publisher", "issueCard"]) assert.ok(properties.brand.properties[field].description, `brand.${field} has a description`);
	});
});

describe("the issue card", () => {
	test("on a newsletter: null until chosen, then true or false, kept by other changes, and null goes back to the default", async () => {
		const user = await customer();
		const Newsletter = (await import("../models/Newsletter.js")).default;
		const stored = async () => (await Newsletter.findOne({ accountId: user.accountId, _id: user.newsletter.id }).lean()).brand?.issueCard;
		assert.equal(user.newsletter.brand.issueCard, null);
		assert.equal((await api(user, "PATCH", `/newsletters/${user.newsletter.slug}`, { replyTo: "hi@example.com" })).body.brand.issueCard, null, "a save leaves it unset");
		assert.equal(await stored(), undefined);
		assert.equal((await patchBrand(user, { issueCard: true })).body.brand.issueCard, true);
		assert.equal((await patchBrand(user, { theme: "bold" })).body.brand.issueCard, true, "other brand changes keep it");
		assert.equal((await patchBrand(user, { issueCard: false })).body.brand.issueCard, false);
		assert.equal(await stored(), false);
		assert.equal((await patchBrand(user, { issueCard: null })).body.brand.issueCard, null);
		assert.equal(await stored(), undefined);
		assert.equal((await patchBrand(user, { issueCard: "yes" })).status, 400);
	});

	test("on an issue: true, false or null to follow the newsletter, through create, update, get and duplicate", async () => {
		const user = await customer();
		const draft = (await api(user, "POST", "/campaigns", { newsletter: user.newsletter.slug, subject: "Card", content: "Hi" })).body;
		assert.equal(draft.issueCard, null, "follows the newsletter");
		assert.equal((await api(user, "PATCH", `/campaigns/${draft.id}`, { issueCard: false })).body.issueCard, false);
		assert.equal((await api(user, "GET", `/campaigns/${draft.id}`)).body.issueCard, false);
		assert.equal((await api(user, "POST", `/campaigns/${draft.id}/duplicate`, {})).body.issueCard, false, "a copy keeps it");
		assert.equal((await api(user, "PATCH", `/campaigns/${draft.id}`, { issueCard: true })).body.issueCard, true);
		assert.equal((await api(user, "PATCH", `/campaigns/${draft.id}`, { subject: "Card again" })).body.issueCard, true, "other changes keep it");
		assert.equal((await api(user, "PATCH", `/campaigns/${draft.id}`, { issueCard: null })).body.issueCard, null);
		const Campaign = (await import("../models/Campaign.js")).default;
		assert.equal((await Campaign.findOne({ accountId: user.accountId, _id: draft.id }).lean()).issueCard, undefined);
		const created = await api(user, "POST", "/campaigns", { newsletter: user.newsletter.slug, subject: "Card on", issueCard: true, content: "Hi" });
		assert.equal(created.body.issueCard, true);
		assert.equal((await api(user, "PATCH", `/campaigns/${draft.id}`, { issueCard: "on" })).status, 400);
	});

	test("is the issue's own word, else the newsletter's, else on for an issue a briefing wrote", () => {
		assert.equal(isIssueCardOn({}, {}), false);
		assert.equal(isIssueCardOn({}, { source: "briefing" }), true);
		assert.equal(isIssueCardOn({}, { source: "api", externalId: "briefing:65a1b2c3d4e5f60718293a4b:2026-10-28" }), true, "a briefing's draft made before it was marked");
		assert.equal(isIssueCardOn({ brand: { issueCard: false } }, { source: "briefing" }), false);
		assert.equal(isIssueCardOn({ brand: { issueCard: true } }, { source: "api" }), true);
		assert.equal(isIssueCardOn({ brand: { issueCard: true } }, { issueCard: false }), false);
		assert.equal(isIssueCardOn({ brand: { issueCard: false } }, { issueCard: true }), true);
		assert.equal(isIssueCardOn(null, null), false);
	});

	test("a briefing's draft is marked as one, so the default shows its card", async () => {
		const user = await customer();
		const { runAction } = await import("../lib/actions/run-action.js");
		const Account = (await import("../models/Account.js")).default;
		const account = await Account.findById(user.accountId).lean();
		const draft = await runAction("create_campaign", { account, via: "briefing", input: { newsletter: user.newsletter.slug, subject: "Briefing", format: "markdown", content: "Hi" } });
		assert.equal(draft.source, "briefing");
		assert.equal((await api(user, "POST", "/campaigns", { newsletter: user.newsletter.slug, subject: "Mine", content: "Hi" })).body.source, "api");
	});
});

describe("the dashboard", () => {
	test("the newsletter form saves the publisher line and the issue card, and leaves the card unset until it is switched", async () => {
		const user = await customer();
		const { saveNewsletter } = await import("../app/(app)/newsletters/actions.js");
		const Newsletter = (await import("../models/Newsletter.js")).default;
		const fields = { id: user.newsletter.id, name: user.newsletter.name, slug: user.newsletter.slug, fromEmail: user.newsletter.fromEmail, postalAddress: "1 Main St, Paris", archiveEnabled: "on" };
		const stored = async () => (await Newsletter.findOne({ accountId: user.accountId, _id: user.newsletter.id }).lean()).brand ?? {};
		assert.equal((await as(user, () => saveNewsletter(null, form({ ...fields, publisher: "by Example Media", issueCard: "" })))).ok, true);
		assert.deepEqual([(await stored()).publisher, (await stored()).issueCard], ["by Example Media", undefined]);
		await as(user, () => saveNewsletter(null, form({ ...fields, publisher: "by Example Media", issueCard: "on" })));
		assert.equal((await stored()).issueCard, true);
		await as(user, () => saveNewsletter(null, form({ ...fields, issueCard: "off" })));
		assert.deepEqual([(await stored()).publisher, (await stored()).issueCard], [undefined, false]);

		const page = await as(user, () => import("../app/(app)/newsletters/page.js").then(({ default: render }) => render()));
		const { TooltipProvider } = await import("../components/ui/tooltip.jsx");
		const html = renderToStaticMarkup(createElement(TooltipProvider, null, page));
		assert.match(html, /<input type="hidden" name="issueCard" value="off"\/>/);
		assert.match(html, /name="publisher"[^>]*maxLength="60"|maxLength="60"[^>]*name="publisher"/);
	});

	test("the issue's choice saves true, false and back to the newsletter's", async () => {
		const user = await customer();
		const draft = (await api(user, "POST", "/campaigns", { newsletter: user.newsletter.slug, subject: "Card", content: "Hi" })).body;
		const { setCampaignIssueCard } = await import("../app/(app)/campaigns/actions.js");
		const Campaign = (await import("../models/Campaign.js")).default;
		const stored = async () => (await Campaign.findOne({ accountId: user.accountId, _id: draft.id }).lean()).issueCard;
		assert.deepEqual(await as(user, () => setCampaignIssueCard(draft.id, true)), { ok: true });
		assert.equal(await stored(), true);
		await as(user, () => setCampaignIssueCard(draft.id, false));
		assert.equal(await stored(), false);
		await as(user, () => setCampaignIssueCard(draft.id, null));
		assert.equal(await stored(), undefined);
	});
});

describe("section icons", () => {
	const BRIEF = { topic: "Battery manufacturing in Europe", audience: "Engineers at small battery companies", useful: "New plants, prices and rules" };

	test("take one of the ten keys, round trip through create, get and update, and null goes back to the default", async () => {
		const user = await customer();
		const sections = [
			{ id: "earnings", title: "Earnings", format: "one-liners", maxItems: 5 },
			{ id: "the-week", title: "The week", format: "sentences", maxItems: 2, icon: "coming-up" },
		];
		const created = await api(user, "POST", "/briefings", { newsletter: user.newsletter.slug, name: "Icons", brief: BRIEF, sections });
		assert.equal(created.status, 201, JSON.stringify(created.body));
		assert.deepEqual(created.body.sections.map(({ icon }) => icon), [null, "coming-up"]);
		assert.deepEqual((await api(user, "GET", `/briefings/${created.body.id}`)).body.sections.map(({ icon }) => icon), [null, "coming-up"]);
		const changed = await api(user, "PATCH", `/briefings/${created.body.id}`, { sections: [{ ...sections[0], icon: "market-pulse" }, { ...sections[1], icon: null }] });
		assert.deepEqual(changed.body.sections.map(({ icon }) => icon), ["market-pulse", null]);
		assert.deepEqual((await api(user, "PATCH", `/briefings/${created.body.id}`, { name: "Renamed" })).body.sections.map(({ icon }) => icon), ["market-pulse", null], "a change without sections keeps them");
		const bad = await api(user, "PATCH", `/briefings/${created.body.id}`, { sections: [{ ...sections[0], icon: "rocketship" }] });
		assert.equal(bad.status, 400);
		assert.equal(bad.body.error.code, "validation_failed");
	});

	test("are described for agents with the keys and the default", async () => {
		const { getAction } = await import("../lib/actions/registry.js");
		const { toJsonSchema } = await import("../lib/docs/reference.js");
		for (const name of ["create_briefing", "update_briefing"]) {
			const { properties } = toJsonSchema(getAction(name).input, "input");
			const icon = properties.sections.items.properties.icon;
			for (const key of SECTION_ICON_KEYS) assert.ok(JSON.stringify(icon).includes(`"${key}"`), `${name} lists ${key}`);
			assert.match(icon.description, /generic/);
		}
	});

	test("the editor shows each section's icon, its own or the default the issue would give it", async () => {
		const { default: SelectSectionIcon, SECTION_ICONS } = await import("../components/SelectSectionIcon.jsx");
		assert.deepEqual(Object.keys(SECTION_ICONS), SECTION_ICON_KEYS);
		const render = (props) => renderToStaticMarkup(createElement(SelectSectionIcon, { onChange: () => {}, ...props }));
		assert.match(render({ sectionId: "earnings" }), /aria-label="Icon: Earnings"/);
		assert.match(render({ sectionId: "earnings" }), /lucide-chart-column|lucide-bar-chart-3/);
		assert.match(render({ sectionId: "earnings", value: "people" }), /aria-label="Icon: People"[\s\S]*lucide-users/);
		assert.match(render({ sectionId: "the-week", title: "The week ahead" }), /aria-label="Icon: Coming up"/, "a known title, as the issue reads it");
		assert.match(render({ sectionId: "the-week", title: "The week" }), /aria-label="Icon: Generic"[\s\S]*lucide-file-text/);
	});
});

describe("the empty state", () => {
	test("shows one icon, its sentence, its words and an optional action, full size or compact", async () => {
		const { default: StateEmpty } = await import("../components/StateEmpty.jsx");
		const { History } = await import("lucide-react");
		const full = renderToStaticMarkup(createElement(StateEmpty, { icon: History, title: "Nothing has run yet", action: createElement("a", { href: "/briefings/new" }, "Set one up") }, createElement("p", null, "Runs show here.")));
		assert.equal((full.match(/<svg/g) ?? []).length, 1);
		assert.match(full, /lucide-history/);
		assert.match(full, /stroke-width="2"/, "the set's one stroke weight");
		assert.match(full, /aria-hidden="true"/);
		assert.match(full, />Nothing has run yet</);
		assert.match(full, /<p>Runs show here\.<\/p>/);
		assert.match(full, /<a href="\/briefings\/new">Set one up<\/a>/);
		assert.match(full, /py-16/);
		const compact = renderToStaticMarkup(createElement(StateEmpty, { icon: History, title: "Nothing has run yet", isCompact: true }));
		assert.match(compact, /lucide-history/);
		assert.match(compact, />Nothing has run yet</);
		assert.doesNotMatch(compact, /py-16/);
	});

	test("is what the dashboard's lists show when they are empty", async () => {
		const { readFile } = await import("node:fs/promises");
		for (const file of ["app/(app)/briefings/page.js", "app/(app)/briefings/[id]/page.js", "app/(app)/briefings/[id]/runs/[runId]/page.js", "app/(app)/series/page.js", "app/(app)/series/[id]/page.js", "app/(app)/ai-keys/page.js", "app/(app)/campaigns/(list)/page.js", "app/(app)/contacts/page.js", "components/CardOffers.jsx", "components/CardGifts.jsx", "components/FormGiftLinks.jsx", "components/TableWebhookDeliveries.jsx"]) {
			assert.match(await readFile(new URL(`../${file}`, import.meta.url), "utf8"), /<StateEmpty\b/, file);
		}
	});
});

describe("a story's link preview", () => {
	test("loads the publisher's https image lazily, with no referrer, a set size and the title as its alt; an icon otherwise", async () => {
		const { default: ImageLinkPreview } = await import("../components/ImageLinkPreview.jsx");
		const html = renderToStaticMarkup(createElement(ImageLinkPreview, { src: "https://cdn.example.com/a.jpg", alt: "Acme opens a plant" }));
		for (const attribute of ['src="https://cdn.example.com/a.jpg"', 'alt="Acme opens a plant"', 'width="56"', 'height="56"', 'loading="lazy"', 'referrerPolicy="no-referrer"']) assert.ok(html.includes(attribute), attribute);
		for (const src of [null, "", "http://cdn.example.com/a.jpg", "javascript:alert(1)", 'https://cdn.example.com/a.jpg" onerror="x']) {
			const fallback = renderToStaticMarkup(createElement(ImageLinkPreview, { src, alt: "A story" }));
			assert.doesNotMatch(fallback, /<img/, String(src));
			assert.match(fallback, /<svg/);
		}
	});
});
