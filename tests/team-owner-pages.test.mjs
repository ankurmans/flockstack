import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { as, form, signIn, startTestApp } from "./helpers/app.mjs";
import { addDraft, agentOwner, api, loadAgentModules } from "./helpers/agents.mjs";
import { TooltipProvider } from "../components/ui/tooltip.jsx";
import { TEAM_COOKIE, acceptTeamInvitation } from "../lib/team.js";

const PAGES = ["app/(app)/api-keys/page.js", "app/(app)/approvals/page.js", "app/(app)/agent-activity/page.js"];
const text = (markup) => markup.replaceAll(/<[^>]+>/g, " ").replaceAll(/\s+/g, " ");
const toUser = (who) => ({ id: String(who.userId), email: who.email, emailVerified: true });

let app, m, owner, account;
const seats = {};

async function render(who, path) {
	const { default: Page } = await import(`../${path}`);
	return text(renderToStaticMarkup(createElement(TooltipProvider, null, await as(who, () => Page({ searchParams: Promise.resolve({}) })))));
}

before(async () => {
	app = await startTestApp();
	m = await loadAgentModules();
	owner = await agentOwner(m, "pages-owner@example.com");
	account = await m.Account.findById(owner.accountId).lean();
	for (const role of ["viewer", "editor", "admin"]) {
		const seat = await signIn(`pages-${role}@example.com`);
		const invite = await as(owner, () => m.runAction("invite_team_member", { account, user: toUser(owner), input: { email: seat.email, role }, via: "dashboard" }));
		await acceptTeamInvitation(toUser(seat), invite.id);
		seat.jar.set(TEAM_COOKIE, String(account._id));
		seats[role] = seat;
	}
	const id = await addDraft(m, owner.keys.send_with_approval, { subject: "Secret pending issue" });
	await api(owner.keys.send_with_approval, "POST", `/campaigns/${id}/send`, {});
	await as(owner, () => m.apiKeys.createApiKey(null, form({ name: "Owner private key", level: "full" })));
});
after(() => app?.stop());

test("a team seat opening the owner's key, approval and activity pages sees none of their data", async () => {
	for (const [role, seat] of Object.entries(seats)) {
		for (const path of PAGES) {
			const page = await render(seat, path);
			assert.match(page, /available to the account owner/, `${role} ${path}`);
			assert.doesNotMatch(page, /Owner private key|Secret pending issue|The exact input that will run|send_with_approval/, `${role} ${path}`);
		}
	}
});

test("the owner still sees them", async () => {
	assert.match(await render(owner, PAGES[0]), /Owner private key/);
	assert.match(await render(owner, PAGES[1]), /Secret pending issue/);
});
