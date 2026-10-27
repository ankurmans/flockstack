import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { setupAudienceTests } from "./helpers/audience.mjs";
import { sent as sesEmails } from "./stubs/ses.mjs";
import { readEmailVariants } from "../lib/automation-variant-rules.js";
import { chooseAutomationEmail } from "../lib/automation-variants.js";
const base = { id: "welcome-email", type: "email", subject: "Welcome", previewText: "Start here", format: "markdown", content: "Base **body**", variants: [{ id: "control", name: "Control" }, { id: "new", name: "New wording", subject: "A different welcome" }] };
const normalize = (input = base, extra = {}) => readEmailVariants(input, { where: "email", complete: true, maxBytes: 500000, ...extra });
function stored(input = base) { const result = normalize(input); assert.equal(result.problem, undefined); return { ...input, markdown: input.content, ...result.fields }; }
test("email variants inherit omitted copy, keep IDs and normalize shares", () => {
	const step = stored(); assert.deepEqual(step.variants.map(({ percent }) => percent), [50, 50]); assert.equal(step.variants[0].markdown, undefined);
	const winner = chooseAutomationEmail({ ...step, winnerVariantId: "new" }, "reader"); assert.equal(winner.subject, "A different welcome"); assert.equal(winner.markdown, base.content); assert.equal(winner.automationVariantPhase, "winner");
	assert.deepEqual(normalize({ ...base, variants: [{}, {}, {}] }).fields.variants.map(({ percent }) => percent), [34, 33, 33]);
});
test("assignment is stable per contact, explicit weights are used, and changed copy receives a distinct revision", () => {
	const step = stored({ ...base, variants: [{ id: "control", percent: 10 }, { id: "new", percent: 90, subject: "New subject" }] });
	let controls = 0;
	for (let i = 0; i < 1000; i++) { const a = chooseAutomationEmail(step, `contact-${i}`), b = chooseAutomationEmail(step, `contact-${i}`); assert.equal(a.automationVariantId, b.automationVariantId); assert.equal(a.automationVariantVersion, b.automationVariantVersion); if (a.automationVariantId === "control") controls++; }
	assert.ok(controls > 40 && controls < 160, `10% allocation gave ${controls}/1000`);
	const selected = { ...step, winnerVariantId: "new" }; const before = chooseAutomationEmail(selected, "same-contact"); const after = chooseAutomationEmail({ ...selected, variants: selected.variants.map((variant) => variant.id === "new" ? { ...variant, subject: "Edited subject" } : variant) }, "same-contact"); assert.equal(before.automationVariantId, after.automationVariantId); assert.notEqual(before.automationVariantVersion, after.automationVariantVersion);
	assert.match(before.automationVariantVersion, /^[a-f0-9]{64}$/);
});
test("invalid tests are refused before sending, including empty copy, malformed weights and unsupported winners", () => {
	for (const change of [{ variants: [{}] }, { variants: [{ id: "same" }, { id: "same" }] }, { variants: [{ percent: 10 }, { percent: 10 }] }, { variants: [{ percent: 10 }, {}] }, { winnerVariantId: "missing" }, { variants: [{}, { subject: "" }] }, { variants: [{}, { content: "" }] }, { variants: [{}, { format: "html" }] }]) assert.ok(normalize({ ...base, ...change }).problem, JSON.stringify(change));
	assert.ok(normalize({ ...base, content: "é".repeat(250000), variants: [{}, { content: "extra" }] }).problem);
	assert.equal(normalize({ ...base, variants: [{}, { subject: "" }] }, { complete: false }).problem, undefined);
	assert.equal(chooseAutomationEmail({ ...stored(), winnerVariantId: "removed" }, "reader"), null);
});

let t, m, owner, automation, delivered;
const request = (method, path, body) => t.api(owner.key, method, path, body);
const inputStep = (changes = {}) => ({ id: "ab-email", type: "email", subject: "Base welcome", previewText: "Start here", format: "markdown", content: "BASE_BODY", variants: [{ id: "control", name: "Control", percent: 50 }, { id: "new", name: "New wording", percent: 50, subject: "Alternative welcome", format: "rich", content: "<p>ALT_BODY for {{email}}</p>" }], ...changes });

before(async () => { t = await setupAudienceTests({ SEND_RATE_PER_SECOND: "1000" }); m = { ...t.m, Automation: (await import("../models/Automation.js")).default, automations: await import("../lib/automations.js") }; owner = await t.customer("automation-ab-owner@example.com"); });
after(() => t?.app.stop());
async function addReader(index) { return m.Contact.create({ accountId: owner.accountId, newsletterId: owner.newsletterId, email: `ab-reader-${index}@automation-ab-owner.example.org`, status: "active" }); }
async function enroll(contacts) { const response = await request("POST", `/automations/${automation.id}/enroll`, { emails: contacts.map(({ email }) => email) }); assert.equal(response.status, 200, JSON.stringify(response.body)); }
async function report() { const response = await request("GET", `/automations/${automation.id}/report`); assert.equal(response.status, 200, JSON.stringify(response.body)); return response.body; }
test("activated automation delivery sends one assigned variant, records its actual copy and reports observed results", async () => {
	const created = await request("POST", "/automations", { newsletter: owner.newsletterId, name: "Welcome A/B", trigger: { type: "api" }, steps: [inputStep()] }); assert.equal(created.status, 201, JSON.stringify(created.body)); automation = created.body;
	assert.equal(automation.steps[0].variants.length, 2); assert.equal(automation.steps[0].variants[0].content, undefined, "inherited bodies are not duplicated in storage or output");
	const activated = await request("POST", `/automations/${automation.id}/activate`); assert.equal(activated.status, 200, JSON.stringify(activated.body));
	const contacts = []; for (let i = 0; i < 30; i++) contacts.push(await addReader(i)); await enroll(contacts); const start = sesEmails.length;
	await m.automations.runAutomations(); delivered = await m.Message.find({ accountId: owner.accountId, automationId: automation.id, sentAt: { $exists: true } }).lean(); assert.equal(delivered.length, 30);
	const ids = new Set(delivered.map((message) => message.automationVariantId)); assert.deepEqual([...ids].sort(), ["control", "new"]);
	const mails = sesEmails.slice(start); assert.equal(mails.length, 30);
	for (const message of delivered) { const mail = mails.find(({ to }) => to === message.email); assert.ok(mail); if (message.automationVariantId === "new") { assert.equal(mail.subject, "Alternative welcome"); assert.match(mail.html, /ALT_BODY/); assert.ok(mail.html.includes(message.email)); } else { assert.equal(mail.subject, "Base welcome"); assert.match(mail.html, /BASE_BODY/); } assert.match(message.automationVariantVersion, /^[a-f0-9]{64}$/); assert.match(message.automationExperimentId, /^[a-f0-9]{64}$/); }
	await m.automations.runAutomations(); assert.equal((await m.Message.find({ accountId: owner.accountId, automationId: automation.id }).lean()).length, 30, "retrying the job cannot create a second email for this enrollment and step");
	const clicked = delivered.find((message) => message.automationVariantId === "new"); await m.Message.updateOne({ accountId: owner.accountId, _id: clicked._id }, { $set: { deliveredAt: new Date(), openedAt: new Date(), clickedAt: new Date() } });
	const result = await report(); assert.equal(result.steps[0].sent, 30); assert.equal(result.steps[0].variants.reduce((sum, row) => sum + row.sent, 0), 30); assert.equal(result.steps[0].variants.find(({ id }) => id === "new").clicked, 1); assert.equal(result.variantGroupsTruncated, false);
	assert.equal((await request("PATCH", `/automations/${automation.id}`, { steps: [inputStep()] })).status, 409, "active copy cannot change");
});
test("paused edits and a manual winner use new copy and remain separate from test sends", async () => {
	await request("POST", `/automations/${automation.id}/pause`); const step = inputStep(); step.variants[1].subject = "CHOSEN_NEW_COPY"; step.winnerVariantId = "new";
	let changed = await request("PATCH", `/automations/${automation.id}`, { steps: [step] }); assert.equal(changed.status, 200, JSON.stringify(changed.body));
	await request("POST", `/automations/${automation.id}/activate`); const reader = await addReader(30); await enroll([reader]); await m.automations.runAutomations();
	const message = await m.Message.findOne({ accountId: owner.accountId, automationId: automation.id, contactId: reader._id }).lean(); assert.equal(message.automationVariantId, "new"); assert.equal(message.automationVariantPhase, "winner"); assert.equal(sesEmails.find(({ to }) => to === reader.email).subject, "CHOSEN_NEW_COPY");
	const result = await report(); const rows = result.steps[0].variants; const winner = rows.find(({ phase }) => phase === "winner"); const previous = rows.find(({ id, phase }) => id === "new" && phase === "test"); assert.equal(winner.sent, 1); assert.notEqual(winner.revision, previous.revision); assert.equal(winner.allocation, previous.allocation);
	await request("POST", `/automations/${automation.id}/pause`); step.winnerVariantId = null; step.variantSeed = "fresh-allocation";
	changed = await request("PATCH", `/automations/${automation.id}`, { steps: [step] }); assert.equal(changed.status, 200, JSON.stringify(changed.body)); await request("POST", `/automations/${automation.id}/activate`);
	const fresh = await addReader(31); await enroll([fresh]); await m.automations.runAutomations(); const latest = await m.Message.findOne({ accountId: owner.accountId, contactId: fresh._id, kind: "automation" }).lean(); assert.equal(latest.automationVariantPhase, "test"); assert.notEqual(latest.automationExperimentId, message.automationExperimentId);
});
test("turning the test off uses the base email and keeps historical reports scoped", async () => {
	await request("POST", `/automations/${automation.id}/pause`); const step = inputStep(); delete step.variants;
	assert.equal((await request("PATCH", `/automations/${automation.id}`, { steps: [step] })).status, 200); await request("POST", `/automations/${automation.id}/activate`);
	const reader = await addReader(32); await enroll([reader]); await m.automations.runAutomations(); const message = await m.Message.findOne({ accountId: owner.accountId, contactId: reader._id, kind: "automation" }).lean(); assert.equal(message.automationVariantId, undefined); assert.equal(sesEmails.find(({ to }) => to === reader.email).subject, "Base welcome"); assert.ok((await report()).steps[0].variants.length >= 3);
	const other = await t.customer("automation-ab-other@example.com"); assert.equal((await t.api(other.key, "GET", `/automations/${automation.id}/report`)).status, 404);
	const bad = inputStep(); bad.variants[1].subject = ""; const draft = await request("POST", "/automations", { newsletter: owner.newsletterId, name: "Invalid variation", trigger: { type: "api" }, steps: [bad] }); assert.equal(draft.status, 201); assert.equal((await request("POST", `/automations/${draft.body.id}/activate`)).status, 422);
});

test("historical group reports are bounded and tell the owner when older groups are omitted", async () => {
	const { ObjectId } = await import("../lib/docdb/index.js"); const now = Date.now();
	await m.Message.insertMany(Array.from({ length: 201 }, (_, i) => ({ accountId: owner.accountId, newsletterId: owner.newsletterId, automationId: automation.id, kind: "automation", enrollmentId: new ObjectId(), stepId: "ab-email", email: `history-${i}@example.com`, automationVariantId: "new", automationVariantName: "Historical", automationVariantPhase: "test", automationExperimentId: "bounded", automationVariantVersion: i.toString(16).padStart(64, "0"), status: "sent", sentAt: new Date(now + i) })));
	const result = await report(); assert.equal(result.variantGroupsTruncated, true); assert.equal(result.steps[0].variants.length, 200); assert.ok(!result.steps[0].variants.some(({ revision }) => revision === "0".repeat(64)));
});

test("a throttled message retries once with the saved copy, and reports the copy actually delivered", async () => {
	const retryOwner = await t.customer("automation-ab-retry@example.com"); const api = (method, path, body) => t.api(retryOwner.key, method, path, body);
	const step = inputStep({ winnerVariantId: "new" });
	const created = await api("POST", "/automations", { newsletter: retryOwner.newsletterId, name: "Retry variants", trigger: { type: "api" }, steps: [step] }); assert.equal(created.status, 201);
	const id = created.body.id; await api("POST", `/automations/${id}/activate`);
	const reader = await m.Contact.create({ accountId: retryOwner.accountId, newsletterId: retryOwner.newsletterId, email: "retry-variant@example.org", status: "active" }); await api("POST", `/automations/${id}/enroll`, { emails: [reader.email] });
	const { state } = await import("./stubs/ses.mjs"); state.failNext = { name: "sendSesEmail", error: Object.assign(new Error("throttled"), { name: "TooManyRequestsException" }) };
	await m.automations.runAutomations();
	const held = await m.Message.findOne({ accountId: retryOwner.accountId, automationId: id }).lean(); assert.equal(held.status, "queued"); assert.equal(held.sentAt, undefined); assert.match(held.automationVariantVersion, /^[a-f0-9]{64}$/);
	await api("POST", `/automations/${id}/pause`); step.variants[1].subject = "RETRY_CHANGED_COPY"; assert.equal((await api("PATCH", `/automations/${id}`, { steps: [step] })).status, 200); await api("POST", `/automations/${id}/activate`);
	await m.automations.runAutomations({ now: new Date(Date.now() + 31 * 60000) });
	const sent = await m.Message.findOne({ accountId: retryOwner.accountId, automationId: id }).lean(); assert.equal(String(sent._id), String(held._id)); assert.equal(sent.status, "sent"); assert.notEqual(sent.automationVariantVersion, held.automationVariantVersion); assert.equal(sesEmails.filter(({ to }) => to === reader.email).length, 1); assert.equal(sesEmails.find(({ to }) => to === reader.email).subject, "RETRY_CHANGED_COPY");
	const result = await api("GET", `/automations/${id}/report`); assert.equal(result.body.steps[0].variants.length, 1); assert.equal(result.body.steps[0].variants[0].sent, 1); assert.equal(result.body.steps[0].variants[0].revision, sent.automationVariantVersion);
});

test("the editor round-trips inherited variants and displays overrides, manual winner mode and separated results", async () => {
	const { fromApiSteps, toApiSteps } = await import("../lib/automation-editor.js"); const [local] = fromApiSteps([inputStep({ winnerVariantId: "new" })]); const [roundTrip] = toApiSteps([local]); assert.equal(roundTrip.variants[0].content, undefined); assert.equal(roundTrip.variants[1].format, "rich"); assert.equal(roundTrip.variants[1].content, inputStep().variants[1].content); assert.equal(roundTrip.winnerVariantId, "new");
	const { createElement } = await import("react"), { renderToStaticMarkup } = await import("react-dom/server"); const Fields = (await import("../components/FieldsAutomationVariants.jsx")).default; const Table = (await import("../components/TableAutomationVariants.jsx")).default;
	const form = renderToStaticMarkup(createElement(Fields, { step: local, onChange() {}, isDisabled: true })); assert.match(form, /Test email variants/); assert.match(form, /Send only New wording/); assert.match(form, /Override subject/); assert.match(form, /disabled=""/);
	const table = renderToStaticMarkup(createElement(Table, { variants: [{ id: "new", name: "Alternative", allocation: "1".repeat(64), revision: "2".repeat(64), phase: "winner", sent: 12, delivered: 10, opened: 4, clicked: 2, bounced: 0, complained: 0 }] })); assert.match(table, /Alternative/); assert.match(table, /Winner/); assert.match(table, /Copy 22222222/); assert.match(table, /allocation 11111111/); assert.match(table, /do not establish a significant winner/);
});
