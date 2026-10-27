import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { setupAudienceTests } from "./helpers/audience.mjs";
let t, owner;
before(async () => { t = await setupAudienceTests(); owner = await t.customer("range-owner@example.com"); });
after(() => t?.app.stop());
test("overview compares the chosen period with an equal previous period and preserves account isolation", async () => {
	const then = new Date(Date.now() - 45 * 86400000);
	await t.m.Campaign.create({ accountId: owner.accountId, newsletterId: owner.newsletterId, subject: "Older issue", status: "sent", sentAt: then, stats: { sent: 42, delivered: 40 } });
	const other = await t.customer("range-other@example.com"); await t.m.Campaign.create({ accountId: other.accountId, newsletterId: other.newsletterId, subject: "Other issue", status: "sent", sentAt: then, stats: { sent: 900 } });
	const read = (days) => t.api(owner.key, "GET", `/overview?newsletter=${owner.newsletterId}&days=${days}`);
	const short = await read(30); assert.equal(short.status, 200, JSON.stringify(short.body)); assert.equal(short.body.emails.current.sent, 0); assert.equal(short.body.emails.previous.sent, 42); assert.equal(short.body.subscribers.days.length, 30);
	const long = await read(90); assert.equal(long.status, 200); assert.equal(long.body.emails.current.sent, 42); assert.equal(long.body.emails.previous.sent, 0); assert.equal(long.body.subscribers.days.length, 90);
	assert.equal((await read(730)).body.subscribers.days.length, 730); assert.equal((await read(731)).status, 400); assert.equal((await read(0)).status, 400);
});
