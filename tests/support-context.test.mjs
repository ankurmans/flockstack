import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, describe, test } from "node:test";
import { activate, addVerifiedDomain, signIn, startTestApp } from "./helpers/app.mjs";

// What the support assistant may know about a signed-in person's account: plan, region, sending domains, a block and
// its reason. Nothing else reaches its prompt.
let app;
let m;

before(async () => {
	app = await startTestApp();
	m = {
		context: await import("../lib/marketing/support-context.js"),
		prompt: await import("../lib/marketing/support-prompt.js"),
		Account: (await import("../models/Account.js")).default,
	};
});

after(() => app?.stop());

const KEYS = ["region", "plan", "domains", "blocked", "blockReason", "welcomePaused", "deletionPending"];

describe("the account context", () => {
	test("a new account: on Free, no domains, not blocked, and only the allowed facts", async () => {
		const user = await signIn("context-new@example.com");
		const context = await m.context.getSupportContext(user.account);
		assert.deepEqual(Object.keys(context), KEYS);
		assert.equal(context.region, "us");
		assert.match(context.plan, /^Free, the plan every account starts on/);
		assert.deepEqual(context.domains, { total: 0, verified: 0 });
		assert.equal(context.blocked, false);
		assert.equal(context.blockReason, null);
	});

	test("a paying account with a verified domain, blocked with a reason", async () => {
		const user = await signIn("context-paid@example.com");
		await activate(user, { plan: "growth", interval: "year" });
		await addVerifiedDomain(user, "context-paid.example.com");
		await m.Account.updateOne({ _id: user.accountId }, { $set: { status: "paused", pauseReason: "Too many bounces in the last 7 days" } });
		const account = await m.Account.findById(user.accountId).lean();
		const context = await m.context.getSupportContext(account);
		assert.equal(context.plan, "Growth, billed yearly");
		assert.deepEqual(context.domains, { total: 1, verified: 1 });
		assert.equal(context.blocked, true);
		assert.equal(context.blockReason, "Too many bounces in the last 7 days");

		const text = m.prompt.formatAccountContext(context);
		assert.match(text, /Plan: Growth, billed yearly\./);
		assert.match(text, /Own sending domains: 1 of 1 verified\./);
		assert.match(text, /blocked\. Reason: Too many bounces in the last 7 days\. Only a person on the FlockStack team can unblock it/);
		assert.match(text, /Region: United States\./);
	});

	test("the prompt holds no email address, name, newsletter, domain name or ID of the account", async () => {
		const user = await signIn("context-private@example.com");
		await activate(user);
		await addVerifiedDomain(user, "private-domain.example.com");
		await m.Account.updateOne({ _id: user.accountId }, { $set: { name: "Secret garden notes" } });
		const account = await m.Account.findById(user.accountId).lean();
		const prompt = m.prompt.buildSystemPrompt({ excerpts: [], context: await m.context.getSupportContext(account) });
		for (const value of ["context-private", "@example.com", "private-domain", "Secret garden", String(user.accountId), String(user.userId)]) {
			assert.ok(!prompt.includes(value), value);
		}
	});

	test("reads one collection, the account's domains, and nothing about subscribers, contacts, campaigns or keys", async () => {
		const source = await readFile(new URL("../lib/marketing/support-context.js", import.meta.url), "utf8");
		assert.deepEqual([...source.matchAll(/from "@\/models\/(\w+)"/g)].map(([, name]) => name), ["Domain"]);
		assert.match(source, /scoped\(account\)/);
	});
});
