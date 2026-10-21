import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { startTestApp } from "./helpers/app.mjs";
import { QSTASH_KEYS, act, createDraft, loadSendingModules, runJobs, setupSender } from "./helpers/sending.mjs";
import { setQueryObserver } from "../lib/docdb/driver.js";

// What a send asks of the database: starting it (messages queued for the whole audience) must cost the same round trips for a
// list of 20 and a list of 120, and a batch of messages must cost a bounded number of them each. A message is about 10 now (claim,
// check the campaign still sends, mark it sent, count it on the campaign and the contact: each update is a read and a write on
// D1), which is what holds a send below the rate the email provider allows when the database is far from the Worker, so a send
// that starts costing more per message, or a start that grows with the list, is caught here.
let app;
let m;
const log = [];

before(async () => {
	app = await startTestApp(QSTASH_KEYS);
	m = await loadSendingModules();
	setQueryObserver((event) => {
		if (!/^\s*(CREATE|PRAGMA)/i.test(event.sql)) log.push(event);
	});
});

after(async () => {
	setQueryObserver(null);
	await app?.stop();
});

async function send(contacts) {
	const user = await setupSender(m, `budget${contacts}@example.com`, { contacts });
	const id = await createDraft(m, user);
	log.length = 0;
	await act(m, user, "send_campaign", { id });
	const start = log.length;
	log.length = 0;
	const jobs = await runJobs({ "/api/jobs/send-batch": m.sendBatchRoute });
	return { start, batch: log.length, jobs: jobs.length, sent: jobs.reduce((total, { result }) => total + (result.sent ?? 0), 0) };
}

test("starting a send costs the same for a small list and a larger one", async () => {
	const small = await send(20);
	const larger = await send(120);
	assert.ok(small.start <= 45, `${small.start} round trips for 20 contacts`);
	assert.ok(larger.start <= small.start + 3, `${larger.start} for 120 against ${small.start} for 20`);
	assert.equal(small.sent, 20);
	assert.equal(larger.sent, 120);
});

test("a message costs a bounded number of round trips, whatever the size of the batch", async () => {
	const small = await send(10);
	const larger = await send(100);
	assert.equal(small.sent, 10);
	assert.equal(larger.sent, 100);
	const perMessage = (batch, sent, jobs) => (batch - jobs * 14) / sent;
	assert.ok(perMessage(small.batch, small.sent, small.jobs) <= 11, `${small.batch} round trips for ${small.sent} messages`);
	assert.ok(perMessage(larger.batch, larger.sent, larger.jobs) <= 11, `${larger.batch} round trips for ${larger.sent} messages in ${larger.jobs} batches`);
});
