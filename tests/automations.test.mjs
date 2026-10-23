import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { checkSteps, describeStep, describeTrigger } from "../lib/automation-rules.js";
import { jsonRequest, readerRoute } from "./helpers/app.mjs";
import { setupAudienceTests } from "./helpers/audience.mjs";
import { sent as sesEmails } from "./stubs/ses.mjs";

let t;
let m;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

before(async () => {
	t = await setupAudienceTests();
	m = {
		automations: await import("../lib/automations.js"),
		jobRoute: await import("../app/api/jobs/run-automations/route.js"),
		unsubscribeRoute: await readerRoute("app/api/unsubscribe/route.js"),
		unsubscribe: await import("../lib/unsubscribe.js"),
		Automation: (await import("../models/Automation.js")).default,
		Enrollment: (await import("../models/AutomationEnrollment.js")).default,
		Alert: (await import("../models/Alert.js")).default,
	};
});

after(() => t?.app.stop());

const WELCOME = [
	{ type: "email", subject: "Welcome, {{first_name|friend}}", content: "Thanks for joining, {{first_name|friend}}." },
	{ type: "wait", amount: 2, unit: "days" },
	{ type: "add_tag", tag: "Onboarded" },
	{ type: "email", subject: "Where to start", content: "Three issues worth your time." },
	{ type: "wait", amount: 1, unit: "days" },
	{ type: "end" },
];

async function customer(email, options) {
	const user = await t.customer(email, options);
	user.address = (name) => `${name}@${user.slug}.example.org`;
	user.mails = (after = 0) => sesEmails.slice(after).filter(({ to }) => to.endsWith(`@${user.slug}.example.org`));
	return user;
}

async function createAutomation(user, { trigger = { type: "subscribed" }, steps = WELCOME, name = "Welcome series", activate = true } = {}) {
	const created = await t.api(user.key, "POST", "/automations", { name, trigger, steps });
	assert.equal(created.status, 201, JSON.stringify(created.body));
	if (activate) {
		const activated = await t.api(user.key, "POST", `/automations/${created.body.id}/activate`);
		assert.equal(activated.status, 200, JSON.stringify(activated.body));
		return activated.body;
	}
	return created.body;
}

const run = (now = new Date()) => m.automations.runAutomations({ now });
const enrollmentsOf = (user, automation) => m.Enrollment.find({ accountId: user.accountId, automationId: automation.id }).lean();
const subscribe = (user, name, body = {}) => t.api(user.signupsKey, "POST", "/contacts", { email: user.address(name), ...body });

describe("an automation's rules", () => {
	test("steps are checked and stored with ids", () => {
		const { steps } = checkSteps([{ type: "email", subject: " Hi ", content: "Body" }, { type: "wait", amount: 3, unit: "hours" }, { type: "add_tag", tag: " VIP " }, { type: "end" }]);
		assert.deepEqual(
			steps.map(({ id, ...step }) => step),
			[{ type: "email", subject: "Hi", previewText: "", format: "markdown", markdown: "Body" }, { type: "wait", amount: 3, unit: "hours" }, { type: "add_tag", tag: "vip" }, { type: "end" }]
		);
		assert.ok(steps.every(({ id }) => /^[a-f0-9]{10}$/.test(id)));
		assert.match(checkSteps([{ type: "wait", amount: 1 }]).problem, /amount and unit/);
		assert.match(checkSteps([{ type: "wait", amount: 400, unit: "days" }]).problem, /a year at most/);
		assert.match(checkSteps([{ type: "add_tag", tag: "<b>" }]).problem, /needs a tag/);
		assert.match(checkSteps([{ id: "a", type: "end" }, { id: "a", type: "end" }]).problem, /used twice/);
		assert.match(checkSteps([{ type: "email", subject: "", content: "x" }], { isComplete: true }).problem, /subject/);
		assert.match(checkSteps(Array.from({ length: 21 }, () => ({ type: "end" }))).problem, /up to 20/);
	});

	test("read as words", () => {
		assert.equal(describeTrigger({ type: "subscribed", tag: "beta" }), "A contact subscribes with the tag beta");
		assert.equal(describeTrigger({ type: "date_field", field: "renews_on", offsetDays: -7, repeat: "yearly" }), "7 days before the date in renews_on, every year");
		assert.equal(describeStep({ type: "wait", amount: 1, unit: "days" }), "Wait 1 day");
	});
});

describe("creating and activating", () => {
	test("an automation starts as a draft and is changed, activated, paused and deleted", async () => {
		const user = await customer("auto-crud@example.com");
		const draft = await createAutomation(user, { activate: false });
		assert.deepEqual({ status: draft.status, steps: draft.steps.length, enrollments: draft.enrollments }, { status: "draft", steps: 6, enrollments: { active: 0, completed: 0, exited: 0 } });
		assert.equal(draft.steps[2].tag, "onboarded");
		assert.match(draft.summary, /^A contact subscribes → Send "Welcome, \{\{first_name\|friend\}\}" → Wait 2 days/);

		const renamed = await t.api(user.key, "PATCH", `/automations/${draft.id}`, { name: "Onboarding", steps: [...draft.steps.slice(0, 2)] });
		assert.deepEqual({ name: renamed.body.name, steps: renamed.body.steps.length }, { name: "Onboarding", steps: 2 });
		assert.equal(renamed.body.steps[0].id, draft.steps[0].id, "steps keep their ids");

		const activated = await t.api(user.key, "POST", `/automations/${draft.id}/activate`);
		assert.equal(activated.body.status, "active");
		assert.equal((await t.api(user.key, "POST", `/automations/${draft.id}/activate`)).status, 200, "safe to repeat");
		assert.match(t.assertError(await t.api(user.key, "PATCH", `/automations/${draft.id}`, { steps: [] }), 409, "conflict"), /Pause the automation first/);
		assert.equal((await t.api(user.key, "PATCH", `/automations/${draft.id}`, { name: "Onboarding v2" })).status, 200, "its name can change");

		const paused = await t.api(user.key, "POST", `/automations/${draft.id}/pause`);
		assert.equal(paused.body.status, "paused");
		assert.equal((await t.api(user.key, "PATCH", `/automations/${draft.id}`, { steps: draft.steps })).status, 200);
		assert.deepEqual((await t.api(user.key, "GET", "/automations")).body.automations.map(({ name, status }) => [name, status]), [["Onboarding v2", "paused"]]);

		assert.deepEqual((await t.api(user.key, "DELETE", `/automations/${draft.id}`)).body, { id: draft.id, deleted: true });
		t.assertError(await t.api(user.key, "GET", `/automations/${draft.id}`), 404, "not_found");
		assert.deepEqual((await t.api(user.key, "GET", "/automations")).body.automations, []);
	});

	test("won't be activated until every email can be sent, or by another account", async () => {
		const user = await customer("auto-activate@example.com");
		const empty = await createAutomation(user, { steps: [], activate: false });
		assert.match(t.assertError(await t.api(user.key, "POST", `/automations/${empty.id}/activate`), 422, "send_check_failed"), /at least one step/);
		const noSubject = await createAutomation(user, { steps: [{ type: "email", subject: "", content: "Hello" }], activate: false });
		assert.match(t.assertError(await t.api(user.key, "POST", `/automations/${noSubject.id}/activate`), 422, "send_check_failed"), /Step 1: add a subject/);
		const noBody = await createAutomation(user, { steps: [{ type: "email", subject: "Hi", content: "" }], activate: false });
		assert.match(t.assertError(await t.api(user.key, "POST", `/automations/${noBody.id}/activate`), 422, "send_check_failed"), /Step 1: add content/);

		const other = await customer("auto-other@example.com");
		t.assertError(await t.api(other.key, "POST", `/automations/${empty.id}/activate`), 404, "not_found");
		t.assertError(await t.api(other.key, "DELETE", `/automations/${empty.id}`), 404, "not_found");
		assert.deepEqual((await t.api(other.key, "GET", "/automations")).body.automations, []);
	});

	test("checks the trigger against the newsletter", async () => {
		const user = await customer("auto-trigger@example.com");
		const create = (trigger) => t.api(user.key, "POST", "/automations", { name: "Test", trigger, steps: [] });
		t.assertError(await create({ type: "tag_added" }), 400, "validation_failed");
		t.assertError(await create({ type: "segment_joined", segment: "nope" }), 404, "not_found");
		t.assertError(await create({ type: "date_field", field: "nope" }), 400, "validation_failed");
		await t.api(user.key, "POST", "/custom-fields", { label: "Seats", type: "number" });
		assert.match(t.assertError(await create({ type: "date_field", field: "seats" }), 400, "validation_failed"), /needs a date field/);
		await t.api(user.key, "POST", "/custom-fields", { label: "Renews on", type: "date" });
		assert.equal((await create({ type: "date_field", field: "renews_on", offsetDays: -3, repeat: "yearly" })).status, 201);
		assert.equal((await create({ type: "tag_added", tag: " VIP " })).body.trigger.tag, "vip");
	});
});

describe("running an automation across time", () => {
	test("sends each step when it's due, waits between them and finishes", async () => {
		const user = await customer("auto-series@example.com");
		await t.api(user.key, "POST", "/custom-fields", { label: "First name", type: "text" });
		const automation = await createAutomation(user);
		const before = sesEmails.length;

		await subscribe(user, "ada", { fields: { first_name: "Ada" } });
		const [enrollment] = await enrollmentsOf(user, automation);
		assert.deepEqual({ status: enrollment.status, trigger: enrollment.trigger, stepIndex: enrollment.stepIndex }, { status: "active", trigger: "subscribed", stepIndex: 0 });

		const start = new Date();
		const first = await run(start);
		assert.equal(first.sent >= 1, true);
		const [welcome] = user.mails(before);
		assert.equal(welcome.subject, "Welcome, Ada");
		assert.ok(welcome.html.includes("Thanks for joining, Ada."));
		assert.ok(welcome.html.includes("/unsubscribe?token="), "an unsubscribe link in every email");
		assert.match(welcome.headers["List-Unsubscribe"], /\/api\/unsubscribe\?token=/);
		assert.equal(welcome.headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");

		let [now] = await enrollmentsOf(user, automation);
		assert.deepEqual({ status: now.status, emailsSent: now.emailsSent, stepIndex: now.stepIndex }, { status: "active", emailsSent: 1, stepIndex: 2 });
		assert.ok(now.nextRunAt.getTime() >= start.getTime() + 2 * DAY_MS - 1000, "waits two days");

		await run(new Date(start.getTime() + 2 * HOUR_MS));
		await run(new Date(start.getTime() + DAY_MS));
		assert.equal(user.mails(before).length, 1, "nothing goes out before it's due");

		await run(new Date(start.getTime() + 2 * DAY_MS + 60_000));
		assert.deepEqual(user.mails(before).map(({ subject }) => subject), ["Welcome, Ada", "Where to start"]);
		assert.deepEqual((await m.Enrollment.findOne({ accountId: user.accountId, automationId: automation.id }).lean()).status, "active", "the last wait is not over");
		assert.deepEqual((await t.m.Contact.findOne({ accountId: user.accountId, email: user.address("ada") }).lean()).tags, ["onboarded"]);

		await run(new Date(start.getTime() + 4 * DAY_MS));
		[now] = await enrollmentsOf(user, automation);
		assert.deepEqual({ status: now.status, emailsSent: now.emailsSent }, { status: "completed", emailsSent: 2 });
		assert.equal(now.nextRunAt, undefined);

		const report = (await t.api(user.key, "GET", `/automations/${automation.id}/report`)).body;
		assert.deepEqual({ entered: report.entered, completed: report.automation.enrollments.completed }, { entered: 1, completed: 1 });
		assert.deepEqual(report.steps.filter(({ type }) => type === "email").map(({ sent }) => sent), [1, 1]);

		await run(new Date(start.getTime() + 10 * DAY_MS));
		assert.equal(user.mails(before).length, 2, "a finished automation sends nothing more");
		assert.equal(await t.m.Message.countDocuments({ accountId: user.accountId, kind: "automation" }), 2);
	});

	test("runs of the job can repeat or overlap without a second email or a second enrollment", async () => {
		const user = await customer("auto-idempotent@example.com");
		const automation = await createAutomation(user, { steps: [{ type: "email", subject: "Once", content: "Only once." }, { type: "wait", amount: 1, unit: "days" }] });
		for (const name of ["a", "b", "c", "d"]) await subscribe(user, name);
		await subscribe(user, "a");
		const before = sesEmails.length;

		const now = new Date();
		await Promise.all([run(now), run(now), run(now)]);
		await run(now);
		assert.equal(user.mails(before).length, 4, "one email per contact, however many runs");
		assert.equal(await t.m.Message.countDocuments({ accountId: user.accountId, kind: "automation" }), 4);
		assert.equal((await enrollmentsOf(user, automation)).length, 4, "one enrollment per contact");

		// A run that died halfway: the enrollment is held, and the email it made is found again, never sent twice.
		const [held] = await m.Enrollment.find({ accountId: user.accountId, automationId: automation.id }).lean();
		await m.Enrollment.updateOne({ accountId: user.accountId, _id: held._id }, { $set: { nextRunAt: now, stepIndex: 0, stepId: held.stepId, lockedUntil: new Date(Date.now() - 1000) } });
		await run(new Date());
		assert.equal(user.mails(before).length, 4, "the sent email is found, not sent again");
		assert.equal((await m.Enrollment.findOne({ accountId: user.accountId, _id: held._id }).lean()).emailsSent, held.emailsSent, "and not counted twice");
	});

	test("the job's route runs it, signed like the others", async () => {
		const user = await customer("auto-route@example.com");
		await createAutomation(user, { steps: [{ type: "email", subject: "Route", content: "From the route." }] });
		await subscribe(user, "r");
		const before = sesEmails.length;
		const response = await m.jobRoute.POST(jsonRequest("/api/jobs/run-automations", { method: "POST", body: {} }));
		assert.equal(response.status, 200);
		assert.equal((await response.json()).sent >= 1, true);
		assert.equal(user.mails(before).length, 1);
	});
});

describe("exits", () => {
	test("a contact who unsubscribes leaves at once, and gets nothing more", async () => {
		const user = await customer("auto-unsub@example.com");
		const automation = await createAutomation(user, { steps: [{ type: "wait", amount: 1, unit: "days" }, { type: "email", subject: "Later", content: "Later." }] });
		const { body: ada } = await subscribe(user, "ada");
		await subscribe(user, "bea");

		const token = m.unsubscribe.createUnsubscribeToken({ contactId: ada.id, newsletterId: user.newsletterId });
		const response = await m.unsubscribeRoute.POST(new Request(`http://localhost:3000/api/unsubscribe?token=${token}`, { method: "POST", body: new FormData() }));
		assert.equal(response.status, 200);
		const enrollments = Object.fromEntries((await enrollmentsOf(user, automation)).map((item) => [String(item.contactId), item]));
		assert.deepEqual({ status: enrollments[ada.id].status, reason: enrollments[ada.id].exitReason }, { status: "exited", reason: "unsubscribed" });

		const before = sesEmails.length;
		await run(new Date());
		await run(new Date(Date.now() + 2 * DAY_MS));
		assert.deepEqual(user.mails(before).map(({ to }) => to.split("@")[0]), ["bea"]);
		const report = (await t.api(user.key, "GET", `/automations/${automation.id}/report`)).body;
		assert.deepEqual({ unsubscribed: report.exits.unsubscribed, exited: report.automation.enrollments.exited, completed: report.automation.enrollments.completed }, { unsubscribed: 1, exited: 1, completed: 1 });
	});

	test("a contact whose status changed behind its back is caught at the next step: bounced, suppressed, deleted", async () => {
		const user = await customer("auto-lazy@example.com");
		const automation = await createAutomation(user, { steps: [{ type: "wait", amount: 1, unit: "days" }, { type: "email", subject: "Later", content: "Later." }] });
		const contacts = {};
		for (const name of ["bounce", "suppress", "gone", "stay"]) contacts[name] = (await subscribe(user, name)).body.id;
		await t.m.Contact.updateOne({ accountId: user.accountId, _id: contacts.bounce }, { $set: { status: "bounced" } });
		await t.m.Suppression.create({ accountId: user.accountId, email: user.address("suppress"), reason: "manual" });
		await t.m.Contact.deleteOne({ accountId: user.accountId, _id: contacts.gone });

		const before = sesEmails.length;
		await run(new Date());
		await run(new Date(Date.now() + 2 * DAY_MS));
		assert.deepEqual(user.mails(before).map(({ to }) => to.split("@")[0]), ["stay"]);
		const reasons = Object.fromEntries((await enrollmentsOf(user, automation)).map((item) => [String(item.contactId), item.exitReason ?? item.status]));
		assert.deepEqual(reasons, { [contacts.bounce]: "bounced", [contacts.suppress]: "suppressed", [contacts.gone]: "deleted", [contacts.stay]: "completed" });
	});

	test("a bounce or a complaint takes the contact out at once", async () => {
		const user = await customer("auto-events@example.com");
		const automation = await createAutomation(user, {
			steps: [{ type: "email", subject: "One", content: "One." }, { type: "wait", amount: 1, unit: "days" }, { type: "email", subject: "Two", content: "Two." }],
		});
		await subscribe(user, "bounce");
		await subscribe(user, "complain");
		await subscribe(user, "stay");
		await run(new Date());
		const messages = await t.m.Message.find({ accountId: user.accountId, kind: "automation" }).lean();
		const { handleEmailEvent } = await import("../lib/email-events.js");
		const of = (name) => messages.find(({ email }) => email === user.address(name));
		await handleEmailEvent({ type: "bounce", bounce: "hard", providerMessageId: of("bounce").providerMessageId, accountId: String(user.accountId), email: user.address("bounce"), emails: [user.address("bounce")], reason: "mailbox does not exist", occurredAt: new Date() });
		await handleEmailEvent({ type: "complaint", providerMessageId: of("complain").providerMessageId, accountId: String(user.accountId), email: user.address("complain"), emails: [user.address("complain")], occurredAt: new Date() });

		const status = Object.fromEntries(
			await Promise.all(
				(await enrollmentsOf(user, automation)).map(async (item) => [
					(await t.m.Contact.findOne({ accountId: user.accountId, _id: item.contactId }).lean()).email.split("@")[0],
					item.exitReason ?? item.status,
				])
			)
		);
		assert.deepEqual(status, { bounce: "bounced", complain: "complained", stay: "active" });
		const before = sesEmails.length;
		await run(new Date(Date.now() + 2 * DAY_MS));
		assert.deepEqual(user.mails(before).map(({ to }) => to.split("@")[0]), ["stay"]);
	});

	test("a contact who isn't active when an email is made is left out of it by the sending path itself", async () => {
		const user = await customer("auto-late@example.com");
		const automation = await createAutomation(user, { steps: [{ type: "email", subject: "Now", content: "Now." }] });
		const { body: ada } = await subscribe(user, "ada");
		await run(new Date());
		const [done] = await enrollmentsOf(user, automation);
		assert.equal(done.status, "completed");
		await t.m.Contact.updateOne({ accountId: user.accountId, _id: ada.id }, { $set: { status: "unsubscribed" } });
		const message = await t.m.Message.findOne({ accountId: user.accountId, kind: "automation" }).lean();
		const { sendMessageBatch } = await import("../lib/sending.js");
		const second = await t.m.Message.create({ ...message, _id: undefined, kind: "automation", stepId: "second", status: "queued", sentAt: undefined });
		const result = await sendMessageBatch({ accountId: String(user.accountId), messageIds: [String(second._id)] });
		assert.equal(result.suppressed, 1, "the sending path checks the contact again");
	});
});

describe("triggers", () => {
	test("a tag starts it once, however often the tag is added", async () => {
		const user = await customer("auto-tag@example.com");
		const automation = await createAutomation(user, { trigger: { type: "tag_added", tag: "vip" }, steps: [{ type: "email", subject: "VIP", content: "Welcome to the VIPs." }] });
		const { body: ada } = await subscribe(user, "ada");
		await subscribe(user, "bea");
		assert.equal((await enrollmentsOf(user, automation)).length, 0, "subscribing is not the trigger");

		await t.api(user.key, "POST", `/contacts/${ada.id}/tags`, { tag: "VIP" });
		await t.api(user.key, "DELETE", `/contacts/${ada.id}/tags?tag=vip`);
		await t.api(user.key, "POST", `/contacts/${ada.id}/tags`, { tag: "vip" });
		assert.equal((await enrollmentsOf(user, automation)).length, 1);
		const before = sesEmails.length;
		await run(new Date());
		assert.deepEqual(user.mails(before).map(({ to }) => to.split("@")[0]), ["ada"]);
	});

	test("subscribing can be limited to a tag or a source", async () => {
		const user = await customer("auto-subscribe@example.com");
		const tagged = await createAutomation(user, { name: "Tagged", trigger: { type: "subscribed", tag: "webinar" }, steps: [{ type: "end" }] });
		const sourced = await createAutomation(user, { name: "Sourced", trigger: { type: "subscribed", source: "partner" }, steps: [{ type: "end" }] });
		await subscribe(user, "plain");
		await subscribe(user, "webinar", { tags: ["webinar"] });
		await subscribe(user, "partner", { source: "partner" });
		const names = async (automation) => Promise.all((await enrollmentsOf(user, automation)).map(async ({ contactId }) => (await t.m.Contact.findOne({ accountId: user.accountId, _id: contactId }).lean()).email.split("@")[0]));
		assert.deepEqual(await names(tagged), ["webinar"]);
		assert.deepEqual(await names(sourced), ["partner"]);
	});

	test("a contact who confirms starts it then, not when they sign up", async () => {
		const user = await customer("auto-confirm@example.com");
		await t.m.Newsletter.updateOne({ accountId: user.accountId, _id: user.newsletterId }, { $set: { requireConfirmation: true } });
		const automation = await createAutomation(user, { steps: [{ type: "end" }] });
		const { body } = await subscribe(user, "pending");
		assert.equal(body.status, "pending");
		assert.equal((await enrollmentsOf(user, automation)).length, 0);
		const { confirmContact } = await import("../lib/contacts.js");
		await confirmContact({ accountId: user.accountId, contactId: body.id, newsletterId: user.newsletterId });
		assert.equal((await enrollmentsOf(user, automation)).length, 1);
	});

	test("joining a segment starts it for those who join after it's on, or for everyone with includeExisting", async () => {
		const user = await customer("auto-segment@example.com");
		await t.importReaders(user, 2, { tags: () => ["beta"] });
		const segment = (await t.api(user.key, "POST", "/segments", { name: "Beta", rules: { match: "all", conditions: [{ type: "tag", value: "beta" }] } })).body;
		const fresh = await createAutomation(user, { name: "From now", trigger: { type: "segment_joined", segment: segment.id }, steps: [{ type: "email", subject: "Beta", content: "You are in the beta." }] });
		const all = await createAutomation(user, { name: "Everyone", trigger: { type: "segment_joined", segment: "Beta", includeExisting: true }, steps: [{ type: "end" }] });

		const start = new Date();
		await run(start);
		assert.equal((await enrollmentsOf(user, all)).filter(({ status }) => status !== "exited").length, 2, "includeExisting starts the ones already in");
		assert.equal((await enrollmentsOf(user, fresh)).filter(({ exitReason }) => exitReason !== "baseline").length, 0, "the ones already in are only recorded");
		assert.deepEqual((await t.api(user.key, "GET", `/automations/${fresh.id}`)).body.enrollments, { active: 0, completed: 0, exited: 0 }, "and not counted");

		const { body: joiner } = await subscribe(user, "joiner");
		await t.api(user.key, "POST", `/contacts/${joiner.id}/tags`, { tag: "beta" });
		await run(new Date(start.getTime() + 5 * 60_000));
		assert.equal((await enrollmentsOf(user, fresh)).filter(({ exitReason }) => exitReason !== "baseline").length, 0, "checked about every hour, not every run");

		const before = sesEmails.length;
		await run(new Date(start.getTime() + 61 * 60_000));
		assert.deepEqual(user.mails(before).map(({ to }) => to.split("@")[0]), ["joiner"]);
		await run(new Date(start.getTime() + 125 * 60_000));
		assert.equal(user.mails(before).length, 1, "a contact who stays in the segment is not started again");
		t.assertError(await t.api(user.key, "DELETE", `/segments/${segment.id}`), 409, "conflict");
	});

	test("a date field starts it on the day, before or after, and every year when asked", async () => {
		const user = await customer("auto-date@example.com");
		await t.api(user.key, "POST", "/custom-fields", { label: "Renews on", type: "date" });
		const today = new Date().toISOString().slice(0, 10);
		const shift = (days) => new Date(Date.parse(`${today}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
		await t.importReaders(user, 4, { fields: (index) => ({ renews_on: [today, shift(7), shift(-1), `2019-${today.slice(5)}`][index] }) });

		const onTheDay = await createAutomation(user, { name: "Day", trigger: { type: "date_field", field: "renews_on" }, steps: [{ type: "end" }] });
		const weekBefore = await createAutomation(user, { name: "Before", trigger: { type: "date_field", field: "renews_on", offsetDays: -7 }, steps: [{ type: "end" }] });
		const yearly = await createAutomation(user, { name: "Yearly", trigger: { type: "date_field", field: "renews_on", repeat: "yearly" }, steps: [{ type: "end" }] });
		const who = async (automation) => (await enrollmentsOf(user, automation)).length;

		const now = new Date();
		await run(now);
		assert.deepEqual([await who(onTheDay), await who(weekBefore), await who(yearly)], [1, 1, 2], "today's date; a week ahead; today's day and month in any year");
		await run(new Date(now.getTime() + 3 * HOUR_MS));
		assert.deepEqual([await who(onTheDay), await who(weekBefore), await who(yearly)], [1, 1, 2], "looked at once a day");

		await run(new Date(now.getTime() + DAY_MS));
		assert.equal(await who(onTheDay), 1, "yesterday's date doesn't start a once-only automation late");
		assert.equal((await enrollmentsOf(user, yearly)).every(({ cycle }) => cycle === today.slice(0, 4)), true, "a yearly enrollment is for its year");
	});
});

describe("limits, blocks and problems", () => {
	test("emails count in the plan's month and wait when it's used up, then go out once it has room", async () => {
		const user = await customer("auto-plan@example.com", { limits: { emailsPerMonth: 2 } });
		const automation = await createAutomation(user, { steps: [{ type: "email", subject: "Plan", content: "Plan." }] });
		for (const name of ["a", "b", "c"]) await subscribe(user, name);
		const before = sesEmails.length;

		const start = new Date();
		await run(start);
		assert.equal(user.mails(before).length, 2, "the plan's two emails");
		assert.equal((await t.m.Account.findById(user.accountId).lean()).usage.emailsSent, 2);
		let enrollments = await enrollmentsOf(user, automation);
		assert.deepEqual(enrollments.map(({ status }) => status).toSorted(), ["active", "completed", "completed"]);
		const waiting = enrollments.find(({ status }) => status === "active");
		assert.ok(waiting.nextRunAt.getTime() > start.getTime(), "it tries again later");
		assert.equal((await t.m.Message.find({ accountId: user.accountId, status: "queued", kind: "automation" }).lean()).length, 1, "its email is made, and kept");
		assert.equal((await m.Alert.findOne({ accountId: user.accountId, key: "automations-plan-limit" }).lean()) !== null, true, "the owner hears of it");

		await run(new Date(start.getTime() + 2 * HOUR_MS));
		assert.equal(user.mails(before).length, 2, "no room, no email");

		await t.m.Account.updateOne({ _id: user.accountId }, { $set: { "limitOverrides.emailsPerMonth": 10 } });
		await run(new Date(start.getTime() + 3 * HOUR_MS));
		assert.equal(user.mails(before).length, 3);
		assert.equal((await t.m.Account.findById(user.accountId).lean()).usage.emailsSent, 3, "counted once each");
		enrollments = await enrollmentsOf(user, automation);
		assert.equal(enrollments.every(({ status }) => status === "completed"), true);
	});

	test("a blocked account's automations don't move, and go on when it's unblocked", async () => {
		const user = await customer("auto-block@example.com");
		const automation = await createAutomation(user, { steps: [{ type: "email", subject: "Block", content: "Block." }] });
		await subscribe(user, "a");
		await t.m.Account.updateOne({ _id: user.accountId }, { $set: { status: "paused", pauseReason: "Spam rate" } });
		const before = sesEmails.length;

		const summary = await run(new Date());
		assert.equal(user.mails(before).length, 0);
		assert.equal((await enrollmentsOf(user, automation))[0].status, "active", "nobody leaves because the account is blocked");
		assert.equal(summary.processed >= 0, true);

		await t.m.Account.updateOne({ _id: user.accountId }, { $set: { status: "active" } });
		await run(new Date());
		assert.equal(user.mails(before).length, 1);
	});

	test("an account whose plan ended is on Free and keeps sending its automations", async () => {
		const user = await customer("auto-noplan@example.com");
		await createAutomation(user, { steps: [{ type: "email", subject: "Plan", content: "Plan." }] });
		await subscribe(user, "a");
		const before = sesEmails.length;
		await t.m.Account.updateOne({ _id: user.accountId }, { $set: { subscriptionStatus: "canceled" } });
		await run(new Date());
		assert.equal(user.mails(before).length, 1);
	});

	test("an account sends no more than its daily room of automated emails, whatever the plan", async () => {
		const user = await customer("auto-room@example.com");
		const automation = await createAutomation(user, { steps: [{ type: "email", subject: "Room", content: "Room." }] });
		await subscribe(user, "waiting");
		const sample = await t.m.Message.create({ kind: "automation", accountId: user.accountId, newsletterId: user.newsletterId, email: user.address("x"), status: "sent", sentAt: new Date() });
		const documents = Array.from({ length: 500 }, (_, index) => ({ kind: "automation", accountId: user.accountId, automationId: automation.id, newsletterId: user.newsletterId, email: user.address(`sent${index}`), status: "sent", sentAt: new Date(), stepId: `fake${index}`, enrollmentId: sample._id }));
		await t.m.Message.insertMany(documents);
		const before = sesEmails.length;
		await run(new Date());
		assert.equal(user.mails(before).length, 0, "the day's room is used");
		const [waiting] = await enrollmentsOf(user, automation);
		assert.equal(waiting.status, "active");
		assert.ok(waiting.nextRunAt.getTime() > Date.now());
		await run(new Date(Date.now() + 2 * DAY_MS));
		assert.equal(user.mails(before).length, 1, "a day later it has room again");
	});

	test("an email that can no longer be sent pauses the automation and tells the owner", async () => {
		const user = await customer("auto-problem@example.com");
		const automation = await createAutomation(user, { steps: [{ type: "email", subject: "Problem", content: "Problem." }] });
		await subscribe(user, "a");
		await t.m.Newsletter.updateOne({ accountId: user.accountId, _id: user.newsletterId }, { $set: { fromEmail: "" } });
		const before = sesEmails.length;
		await run(new Date());
		assert.equal(user.mails(before).length, 0);
		const stored = (await t.api(user.key, "GET", `/automations/${automation.id}`)).body;
		assert.equal(stored.status, "paused");
		assert.match(stored.pauseReason, /from email/);
		assert.equal((await enrollmentsOf(user, automation))[0].status, "active", "contacts stay where they were");
		assert.ok(await m.Alert.findOne({ accountId: user.accountId, key: `automation-paused-${automation.id}` }).lean());
	});

	test("a paused automation sends nothing and picks up where it left off", async () => {
		const user = await customer("auto-pause@example.com");
		const automation = await createAutomation(user, { steps: [{ type: "wait", amount: 1, unit: "hours" }, { type: "email", subject: "Pause", content: "Pause." }] });
		await subscribe(user, "a");
		const start = new Date();
		await run(start);
		await t.api(user.key, "POST", `/automations/${automation.id}/pause`);
		await subscribe(user, "b");
		assert.equal((await enrollmentsOf(user, automation)).length, 1, "nobody enters while it's paused");
		const before = sesEmails.length;
		await run(new Date(start.getTime() + 3 * HOUR_MS));
		assert.equal(user.mails(before).length, 0);
		await t.api(user.key, "POST", `/automations/${automation.id}/activate`);
		await run(new Date(start.getTime() + 3 * HOUR_MS));
		assert.deepEqual(user.mails(before).map(({ to }) => to.split("@")[0]), ["a"]);
	});
});

describe("the sending path", () => {
	test("automated emails are tracked, counted in the account's health and reported by step", async () => {
		const user = await customer("auto-path@example.com");
		const automation = await createAutomation(user, { steps: [{ type: "email", subject: "Path", content: "Read [this](https://example.com/a)." }] });
		await subscribe(user, "a");
		const before = sesEmails.length;
		await run(new Date());
		const [mail] = user.mails(before);
		assert.match(mail.html, /\/o\/[a-f0-9]{24}\./, "an open pixel");
		assert.match(mail.html, /\/c\/[a-f0-9]{24}\./, "tracked links");
		const message = await t.m.Message.findOne({ accountId: user.accountId, kind: "automation" }).lean();
		assert.deepEqual({ status: message.status, automationId: String(message.automationId), hasEnrollment: Boolean(message.enrollmentId) }, { status: "sent", automationId: automation.id, hasEnrollment: true });
		const { countRecentSends } = await import("../lib/account-health.js");
		assert.equal((await countRecentSends(user.accountId)).sent, 1);
		const { handleEmailEvent } = await import("../lib/email-events.js");
		await handleEmailEvent({ type: "delivered", providerMessageId: message.providerMessageId, accountId: String(user.accountId), occurredAt: new Date() });
		await handleEmailEvent({ type: "open", providerMessageId: message.providerMessageId, accountId: String(user.accountId), occurredAt: new Date() });
		const report = (await t.api(user.key, "GET", `/automations/${automation.id}/report`)).body;
		assert.deepEqual({ sent: report.steps[0].sent, delivered: report.steps[0].delivered, opened: report.steps[0].opened }, { sent: 1, delivered: 1, opened: 1 });
		assert.deepEqual(report.rates, { delivered: 1, opened: 1, clicked: 0, bounced: 0 });
		assert.ok((await t.m.Contact.findOne({ accountId: user.accountId, email: user.address("a") }).lean()).lastOpenAt, "an open counts as the contact's");
	});

	test("sends on the bulk lane of a provider that has one, and counts toward the account's health", async () => {
		const { isBulkKind } = await import("../lib/email-provider/postshiba-rules.js");
		assert.equal(isBulkKind("automation"), true);
		const { CAMPAIGN_MESSAGE_KINDS } = await import("../lib/sending-rules.js");
		assert.equal(CAMPAIGN_MESSAGE_KINDS.includes("automation"), false, "it is not a campaign's message");
	});
});
