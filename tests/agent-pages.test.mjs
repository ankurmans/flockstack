import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { as, form, startTestApp } from "./helpers/app.mjs";
import { addDraft, agentOwner, api, loadAgentModules } from "./helpers/agents.mjs";
import { TooltipProvider } from "../components/ui/tooltip.jsx";
import { findWhere, renderShallow } from "./helpers/shallow.mjs";

// The dashboard pages for agents: the API keys page with its levels, the Approvals page, the Agent activity page and the
// banner above every page.
let app;
let m;
let owner;
let emptyOwner;

const html = (element) => renderToStaticMarkup(element);
const text = (markup) => markup.replaceAll(/<[^>]+>/g, " ").replaceAll(/\s+/g, " ");

async function renderPage(user, path, searchParams = {}) {
	const { default: Page } = await import(path);
	return html(createElement(TooltipProvider, null, await as(user, () => Page({ searchParams: Promise.resolve(searchParams) }))));
}

before(async () => {
	app = await startTestApp();
	m = await loadAgentModules();
	owner = await agentOwner(m, "agent-pages@example.com");
	emptyOwner = await agentOwner(m, "agent-pages-empty@example.com");
	await m.Contact.insertMany(
		Array.from({ length: 3 }, (_, index) => ({ accountId: owner.accountId, newsletterId: owner.newsletterId, email: `page${index}@pages.example.org`, status: "active", lastSentAt: new Date(Date.now() - 86_400_000) }))
	);
});

after(() => app?.stop());

describe("API keys", () => {
	test("the page says what each key can do, which newsletter it is limited to, its calls today and its expiry", async () => {
		await as(owner, () => m.apiKeys.createApiKey(null, form({ name: "Limited analyst", level: "read_only", newsletter: owner.newsletterId, dailyCap: "40", expiresInDays: "30" })));
		await api(owner.keys.read_only, "GET", "/campaigns");
		const page = text(await renderPage(owner, "../app/(app)/api-keys/page.js"));
		for (const label of ["Read only", "Drafts only", "Send with approval", "Full access", "Signups only"]) assert.match(page, new RegExp(label), label);
		assert.match(page, /Limited analyst/);
		assert.match(page, /Only agent-pages one\./, "the newsletter it is limited to");
		assert.match(page, /0 of 40/, "calls today and its cap");
		assert.match(page, /Calls today/);
		assert.match(page, /Expires/);
		assert.match(page, /Read everything, including subscribers\./);
		assert.match(page, /Approvals/);
	});

	test("the new key form offers the levels in plain words, with send with approval picked, a newsletter, an expiry and a cap", async () => {
		const { FormApiKey } = await import("../components/DialogCreateApiKey.jsx");
		const { Dialog } = await import("../components/ui/dialog.jsx");
		const markup = html(createElement(Dialog, { open: true }, createElement(FormApiKey, { newsletters: [{ id: owner.newsletterId, name: "Newsletter one" }] })));
		const page = text(markup);
		for (const label of ["Read only", "Drafts only", "Send with approval", "Full access", "Signups only"]) assert.match(page, new RegExp(label), label);
		assert.match(page, /Looks at campaigns, subscribers and reports\. Changes nothing\./);
		assert.match(page, /Recommended for agents/);
		assert.match(markup, /<input[^>]*checked=""[^>]*value="send_with_approval"|<input[^>]*value="send_with_approval"[^>]*checked=""/);
		assert.match(markup, /name="level"/);
		assert.match(page, /All newsletters Newsletter one/);
		assert.match(page, /Never In 7 days In 30 days In 90 days In a year/);
		assert.match(markup, /name="dailyCap"/);
	});
});

describe("Approvals", () => {
	let pending;

	before(async () => {
		const key = owner.keys.send_with_approval;
		const id = await addDraft(m, key, { subject: "The long weekend issue" });
		pending = (await api(key, "POST", `/campaigns/${id}/send`, {})).body;
		pending.campaignId = id;
	});

	test("with nothing waiting it says so, and the toggle for each newsletter is there", async () => {
		const page = text(await renderPage(emptyOwner, "../app/(app)/approvals/page.js"));
		assert.match(page, /Nothing is waiting for you/);
		assert.match(page, /Ask me before an agent sends/);
		assert.match(page, new RegExp(`${emptyOwner.slug} one`));
		assert.match(page, new RegExp(`${emptyOwner.slug} two`));
	});

	test("a waiting request shows who asked, what would happen, the exact input, and the two answers", async () => {
		const markup = await renderPage(owner, "../app/(app)/approvals/page.js");
		const page = text(markup);
		assert.match(page, /Send a campaign now/);
		assert.match(page, /send_with_approval key · API key · asked just now/);
		assert.match(page, /Subject The long weekend issue/);
		assert.match(page, /Goes to 3 contacts/);
		assert.match(page, /Open the draft/);
		assert.match(page, /The exact input that will run/);
		assert.match(page, new RegExp(pending.campaignId));
		assert.match(page, /Reject/);
		assert.match(page, /Approve/);
		assert.match(page, /This key asks before it sends or deletes\./);
		assert.doesNotMatch(page, /Look again before you approve/);
	});

	test("a campaign edited since the request shows the warning and asks for the current version", async () => {
		await new Promise((resolve) => setTimeout(resolve, 5));
		await api(owner.keys.drafts, "PATCH", `/campaigns/${pending.campaignId}`, { subject: "Edited after the request" });
		const page = text(await renderPage(owner, "../app/(app)/approvals/page.js"));
		assert.match(page, /Look again before you approve\. Since it was proposed, it was edited\./);
		assert.match(page, /Approve the current version/);
	});

	test("the owner's answer from the card runs the stored action, and the page lists the decided request with the note", async () => {
		const { default: CardApproval } = await import("../components/CardApproval.jsx");
		const approval = m.approvalLib.toApprovalView(await m.approvalLib.getApproval({ _id: owner.accountId }, pending.approvalId), { includeInput: true });
		const { tree, transitions } = renderShallow(createElement(CardApproval, { approval, staleness: "Since it was proposed, it was edited." }));
		const buttons = findWhere(tree, (node) => node.type?.name === "Button" || node.props?.onClick);
		const approve = buttons.find((node) => JSON.stringify(node.props.children).includes("Approve the current version"));
		assert.ok(approve, "the button asks for the current version");
		const reject = buttons.find((node) => JSON.stringify(node.props.children).includes("Reject"));
		assert.ok(reject);
		await as(owner, async () => {
			approve.props.onClick();
			await Promise.all(transitions);
		});
		const row = await m.ApprovalRequest.findOne({ _id: pending.approvalId, accountId: owner.accountId }).lean();
		assert.equal(row.status, "approved", "the click went to the server action, with the warning acknowledged");
		assert.notEqual((await m.Campaign.findOne({ _id: pending.campaignId, accountId: owner.accountId }).lean()).status, "draft", "the approved send went out");
	});

	test("decided requests are listed with their outcome and the note", async () => {
		const key = owner.keys.send_with_approval;
		const refused = await api(key, "DELETE", `/campaigns/${await addDraft(m, key)}`);
		await as(owner, () => m.approvals.decideApproval(refused.body.approvalId, "reject", "Wrong audience"));
		const page = text(await renderPage(owner, "../app/(app)/approvals/page.js"));
		assert.match(page, /Decided/);
		assert.match(page, /Rejected/);
		assert.match(page, /Approved and done/);
		assert.match(page, /Wrong audience/);
	});

	test("the banner above every page counts what waits, and is gone when nothing does", async () => {
		const { default: BannerApprovals } = await import("../components/BannerApprovals.jsx");
		const account = await m.Account.findById(owner.accountId).lean();
		assert.equal(html(await BannerApprovals({ account })), "", "nothing waits");
		const key = owner.keys.send_with_approval;
		await api(key, "DELETE", `/campaigns/${await addDraft(m, key)}`);
		assert.match(text(html(await BannerApprovals({ account }))), /An AI agent is waiting for your approval\. Nothing happens until you decide\./);
		await api(key, "DELETE", `/campaigns/${await addDraft(m, key)}`);
		const two = html(await BannerApprovals({ account }));
		assert.match(text(two), /2 requests from AI agents are waiting for your approval/);
		assert.match(two, /href="\/approvals"/);
	});

	test("the menu and the palette lead to the pages", async () => {
		const { PAGES } = await import("../lib/palette.js");
		for (const href of ["/approvals", "/agent-activity"]) assert.ok(PAGES.some((page) => page.href === href), href);
		const { isAppRoute } = await import("../lib/app-routes.js");
		for (const path of ["/approvals", "/agent-activity", "/agent-activity?actor=x"]) assert.ok(isAppRoute(path.split("?")[0]), path);
		const { default: MenuUser } = await import("../components/MenuUser.jsx");
		const { tree } = renderShallow(createElement(MenuUser, { name: "A", email: "a@example.com", status: { tone: "green", label: "Sending" }, hasBilling: true }));
		assert.ok(tree);
	});
});

describe("Agent activity", () => {
	test("it lists what agents did, with the filters, and a key's own view", async () => {
		await api(owner.keys.drafts, "POST", "/campaigns", { subject: "Activity page", content: "x", newsletter: owner.slug });
		await api(owner.keys.read_only, "POST", "/campaigns", { subject: "Refused" });
		const page = text(await renderPage(owner, "../app/(app)/agent-activity/page.js"));
		assert.match(page, /Agent activity/);
		assert.match(page, /create_campaign/);
		assert.match(page, /drafts key/);
		assert.match(page, /Denied/);
		assert.match(page, /Calls per day/);
		assert.match(page, /Key or app/);
		assert.match(page, /never what an email says or who it went to/);

		const keyDoc = await m.ApiKey.findOne({ accountId: owner.accountId, name: "drafts key" }).lean();
		const perKey = text(await renderPage(owner, "../app/(app)/agent-activity/page.js", { actor: String(keyDoc._id) }));
		assert.match(perKey, /Activity of drafts key/);
		assert.match(perKey, /Drafts only/);
		assert.match(perKey, /calls today/);
		assert.doesNotMatch(perKey, /Denied/, "the refused call was another key's");

		const filtered = text(await renderPage(owner, "../app/(app)/agent-activity/page.js", { status: "denied", action: "create_campaign" }));
		assert.match(filtered, /Denied/);
		assert.doesNotMatch(filtered, /\bOk\b/, "only the refused ones");
	});

	test("with no activity it says so, and says what the log keeps", async () => {
		const page = text(await renderPage(emptyOwner, "../app/(app)/agent-activity/page.js"));
		assert.match(page, /No agent activity/);
		assert.match(page, /90 days/);
	});

	test("a bad filter changes nothing", async () => {
		const page = text(await renderPage(owner, "../app/(app)/agent-activity/page.js", { status: "bogus", days: "5000", newsletter: "nope", cursor: "garbage", actor: "x" }));
		assert.match(page, /Agent activity/);
	});
});

describe("the consent of an app is not an approval", () => {
	test("deciding from the page needs the owner's own session", async () => {
		const result = await as(emptyOwner, () => m.approvals.decideApproval("6650f1c2e9b1d4a012345678", "approve"));
		assert.equal(result.error, "Approval not found");
		await assert.rejects(m.approvals.decideApproval("6650f1c2e9b1d4a012345678", "approve"), "signed out, there is no account to decide for");
	});
});
