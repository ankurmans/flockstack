import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { form, startTestApp } from "./helpers/app.mjs";
import { creator, nextIp } from "./helpers/growth.mjs";
import { runWithRequest } from "./stubs/next-headers.mjs";
import { flushAfter } from "./stubs/next-server.mjs";

let app;
let m;
before(async () => {
	app = await startTestApp();
	m = {
		archive: await import("../app/archive/actions.js"),
		contacts: await import("../lib/contacts.js"),
		Contact: (await import("../models/Contact.js")).default,
		Message: (await import("../models/Message.js")).default,
	};
});
after(() => app?.stop());

async function subscribe(user, email) {
	const ip = nextIp();
	const result = await runWithRequest({ headers: { "x-forwarded-for": ip } }, () => m.archive.subscribe(null, form({ newsletter: user.slug, email })));
	await flushAfter();
	return result;
}

test("a newsletter that confirms answers the same for a new address and one already subscribed", async () => {
	const user = await creator("uniform1");
	const fresh = await subscribe(user, "stranger@example.net");
	assert.equal(fresh.pending, true);
	await subscribe(user, "member@example.net");
	const member = await m.Contact.findOne({ accountId: user.accountId, newsletterId: user.newsletterId, email: "member@example.net" }).lean();
	await m.contacts.confirmContact({ accountId: user.accountId, contactId: member._id, newsletterId: user.newsletterId });
	assert.equal((await m.Contact.findOne({ accountId: user.accountId, _id: member._id }).lean()).status, "active");
	const emailsBefore = await m.Message.countDocuments({ accountId: user.accountId, email: "member@example.net" });

	const again = await subscribe(user, "member@example.net");
	assert.deepEqual({ ...again, email: undefined }, { ...fresh, email: undefined });
	assert.equal(again.email, "member@example.net");
	assert.equal(await m.Message.countDocuments({ accountId: user.accountId, email: "member@example.net" }), emailsBefore, "and nothing is sent to the subscriber");
	assert.equal((await m.Contact.findOne({ accountId: user.accountId, _id: member._id }).lean()).status, "active", "who stays subscribed");
});

test("a newsletter without confirmation still answers a returning subscriber as before", async () => {
	const user = await creator("uniform2", { confirm: false });
	const first = await subscribe(user, "member@example.net");
	assert.equal(first.pending, undefined);
	assert.equal((await subscribe(user, "member@example.net")).pending, undefined);
});
