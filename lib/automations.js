import "server-only";
import { scoped } from "@/lib/account-scope";
import { areWelcomeEmailsPaused, getAccountSendProblem } from "@/lib/account-state";
import { actionError } from "@/lib/actions/errors";
import { sendAlert } from "@/lib/alerts";
import { enrollContact, getExitReason } from "@/lib/automation-triggers";
import {
	MAX_TOTAL_STEPS,
	SCHEDULED_TRIGGERS,
	SEGMENT_EVALUATION_MINUTES,
	checkSteps,
	describeStep,
	getSplitSeed,
	getWaitMs,
	getWaitUntil,
	indexSteps,
	isDurationWait,
	listSteps,
	nextStep,
	pickSplitPath,
} from "@/lib/automation-rules";
import { getSendVolumes } from "@/lib/campaign-queries";
import { isCloud, isSendingEnabled } from "@/lib/config";
import { buildFieldUpdate, listCustomFields, toContactUpdate } from "@/lib/custom-fields";
import { connectDb } from "@/lib/db";
import { UNDELIVERABLE_MESSAGE } from "@/lib/global-suppressions";
import { insertIgnoringDuplicates } from "@/lib/insert-ignoring-duplicates";
import { mailboxProvider } from "@/lib/providers";
import { compileCondition } from "@/lib/segment-rules";
import { compileRulesFor, contactMatchesRules, findSegmentByReference, validateRules } from "@/lib/segments";
import { createSenderCache } from "@/lib/sender";
import { getAllowance, getWarmupDay } from "@/lib/send-spread";
import { sendMessageBatch } from "@/lib/sending";
import { MAX_BATCH_MESSAGES, chunk, getSendProblem } from "@/lib/sending-rules";
import { normalizeTag } from "@/lib/tag-rules";
import { addTags, removeTags } from "@/lib/tags";
import { normalizeEmail } from "@/lib/validation";
import { getContactChanges, toAutomationStepData } from "@/lib/webhook-events";
import { emitSubscriberUpdated, emitWebhookEvent } from "@/lib/webhooks";
import { hasContent } from "@/lib/render-email";
import Account from "@/models/Account";
import Automation from "@/models/Automation";
import AutomationEnrollment from "@/models/AutomationEnrollment";
import AutomationWatch from "@/models/AutomationWatch";
import Campaign from "@/models/Campaign";
import Contact from "@/models/Contact";
import CustomField from "@/models/CustomField";
import Message from "@/models/Message";
import Newsletter from "@/models/Newsletter";
import Product from "@/models/Product";
import Segment from "@/models/Segment";
import Suppression from "@/models/Suppression";

export const MAX_AUTOMATIONS_PER_NEWSLETTER = 50;

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
// A run of the job holds the contacts it works on this long; one that dies leaves them free after it.
const LOCK_MS = 10 * MINUTE_MS;
const PARK_ACCOUNT_MS = 60 * MINUTE_MS;
const PARK_HELD_MS = 30 * MINUTE_MS;
// Steps that don't send anything run in one go, and so do a few emails in a row; past this the contact waits for the next run.
const MAX_ROUNDS = 5;
const DEFAULT_LIMIT = 200;
const EVALUATION_PAGE = 500;
const EVALUATION_BUDGET = 2000;
// What an account's automations may send in a day, as a campaign goes at full speed up to its proven volume
// (lib/send-spread.js getAllowance), with this much room at least so a welcome series works from the first day.
const DAILY_FLOOR = 500;
const SENT_STATUSES = new Set(["sent", "delivered", "bounced", "complained"]);
const IN_USE_ACCOUNT_STATUSES = ["paused"];

// ---- Checking what a caller sends

async function findTriggerSegment(account, newsletterId, input, fail) {
	if (!input.segment) throw fail(`${input.type} needs a segment`);
	return findSegmentByReference(account, input.segment, newsletterId);
}

export async function validateTrigger(account, newsletterId, input) {
	const fail = (message) => actionError("validation_failed", `trigger: ${message}`);
	const tag = input.tag === undefined ? undefined : normalizeTag(input.tag);
	if (input.tag !== undefined && !tag) throw fail("tag isn't a valid tag");
	switch (input.type) {
		case "subscribed":
			return { type: "subscribed", ...(tag && { tag }), ...(input.source?.trim() && { source: input.source.trim() }) };
		case "tag_added":
		case "tag_removed":
			if (!tag) throw fail(`${input.type} needs a tag`);
			return { type: input.type, tag };
		case "segment_joined": {
			const segment = await findTriggerSegment(account, newsletterId, input, fail);
			return { type: "segment_joined", segmentId: String(segment._id), includeExisting: input.includeExisting === true };
		}
		case "segment_left": {
			const segment = await findTriggerSegment(account, newsletterId, input, fail);
			return { type: "segment_left", segmentId: String(segment._id) };
		}
		case "field_changed": {
			if (!input.field) throw fail("field_changed needs a field");
			const field = await CustomField.findOne(scoped(account, { newsletterId, key: input.field.toLowerCase() })).lean();
			if (!field) throw fail(`the newsletter has no custom field ${input.field}`);
			return { type: "field_changed", field: field.key };
		}
		case "upgraded":
		case "downgraded":
		case "manual":
		case "api":
			return { type: input.type };
		case "product_bought": {
			if (!input.product) return { type: "product_bought" };
			if (!/^[a-f0-9]{24}$/i.test(input.product) || !(await Product.exists(scoped(account, { _id: input.product.toLowerCase(), newsletterId })))) {
				throw fail("the newsletter has no such product");
			}
			return { type: "product_bought", product: input.product.toLowerCase() };
		}
		case "referral_credited":
			return { type: "referral_credited", ...(input.referrals && { referrals: input.referrals }) };
		case "unengaged":
			if (!input.days) throw fail("unengaged needs days");
			return { type: "unengaged", days: input.days, includeExisting: input.includeExisting === true };
		case "link_clicked": {
			let url = null;
			try {
				url = ["http:", "https:"].includes(new URL(input.url ?? "").protocol) ? input.url.trim() : null;
			} catch {
				url = null;
			}
			if (!url) throw fail("link_clicked needs url, the address of a link as it is in the issue");
			if (input.campaign && (!/^[a-f0-9]{24}$/i.test(input.campaign) || !(await Campaign.exists(scoped(account, { _id: input.campaign.toLowerCase(), newsletterId }))))) {
				throw fail("the newsletter has no such issue");
			}
			return { type: "link_clicked", url, ...(input.campaign && { campaign: input.campaign.toLowerCase() }) };
		}
		default: {
			if (!input.field) throw fail("date_field needs a field");
			const field = await CustomField.findOne(scoped(account, { newsletterId, key: input.field.toLowerCase() })).lean();
			if (!field) throw fail(`the newsletter has no custom field ${input.field}`);
			if (field.type !== "date") throw fail(`${field.key} is a ${field.type} field: date_field needs a date field`);
			return { type: "date_field", field: field.key, offsetDays: input.offsetDays ?? 0, repeat: input.repeat ?? "once" };
		}
	}
}

// What the pure check can't: a field, a segment, an automation and a condition's polls, issues and lists have to exist in
// this newsletter. Edits the steps in place: a branch's saved segment becomes its segmentId, its rules and a field's value
// their stored forms.
async function checkStepReferences(account, newsletterId, steps, selfId) {
	const fields = new Map((await listCustomFields(account, newsletterId)).map((field) => [field.key, field]));
	const all = listSteps(steps).map(({ step }) => step);
	for (const step of all) {
		if (step.type === "set_field") {
			const field = fields.get(step.field);
			if (!field) throw actionError("validation_failed", `${describeStepPlace(steps, step)}: the newsletter has no custom field ${step.field}`);
			const update = buildFieldUpdate([field], { [field.key]: step.value });
			step.value = update.set[`fields.${field.key}`] ?? null;
		} else if (step.type === "branch") {
			if (step.rules) step.rules = await validateRules(account, newsletterId, step.rules);
			else {
				const segment = await findSegmentByReference(account, step.segment, newsletterId).catch((error) => {
					if (error.code === "not_found") throw actionError("validation_failed", `${describeStepPlace(steps, step)}: the newsletter has no segment ${step.segment}`);
					throw error;
				});
				step.segmentId = String(segment._id);
				delete step.segment;
			}
		} else if (step.type === "move") {
			const target = await Automation.findOne(scoped(account, { _id: step.automation, newsletterId, status: { $ne: "deleted" } })).select({ _id: 1 }).lean();
			if (!target) throw actionError("validation_failed", `${describeStepPlace(steps, step)}: the newsletter has no such automation to move contacts to`);
			if (selfId && String(target._id) === String(selfId)) throw actionError("validation_failed", `${describeStepPlace(steps, step)}: an automation can't move contacts to itself`);
		}
	}
}

// "Step 3" for a step in the main list, "Step 3, path 2, step 1" for one inside a path.
export function describeStepPlace(steps, target) {
	const chain = [];
	let found = null;
	const search = (list, labels) => {
		for (const [index, step] of list.entries()) {
			const here = [...labels, `${labels.length === 0 ? "Step" : "step"} ${index + 1}`];
			if (step === target || (target.id && step.id === target.id)) {
				found = here;
				return true;
			}
			for (const [pathIndex, path] of (step.paths ?? []).entries()) {
				if (search(path.steps, [...here, `path ${pathIndex + 1}`])) return true;
			}
		}
		return false;
	};
	search(steps, chain);
	return found ? found.join(", ") : "Step";
}

// Steps from a caller, checked and ready to store, or a validation error. selfId: the automation they belong to.
export async function validateSteps(account, newsletterId, input, { isComplete = false, selfId = null } = {}) {
	const { steps, problem } = checkSteps(input, { isComplete });
	if (problem) throw actionError("validation_failed", problem);
	await checkStepReferences(account, newsletterId, steps, selfId);
	return steps;
}

export function toTriggerOutput(trigger) {
	const { segmentId, ...rest } = trigger;
	return { ...rest, ...(segmentId && { segment: segmentId }) };
}

// What stops an automation from being switched on, as a sentence, or null.
export async function getActivationProblem({ account, automation, newsletter, senderFor }) {
	const accountProblem = getAccountSendProblem(account);
	if (accountProblem) return accountProblem.message;
	if (!isSendingEnabled()) return "Sending is off";
	if (automation.steps.length === 0) return "Add at least one step";
	const { trigger } = automation;
	if (["segment_joined", "segment_left"].includes(trigger.type) && !(await Segment.exists(scoped(account, { _id: trigger.segmentId })))) {
		return "The segment this starts from was deleted: pick another";
	}
	if (trigger.type === "date_field" && !(await CustomField.exists(scoped(account, { newsletterId: automation.newsletterId, key: trigger.field, type: "date" })))) {
		return `The date field ${trigger.field} was deleted: pick another`;
	}
	if (trigger.type === "field_changed" && !(await CustomField.exists(scoped(account, { newsletterId: automation.newsletterId, key: trigger.field })))) {
		return `The field ${trigger.field} was deleted: pick another`;
	}
	if (trigger.type === "product_bought" && trigger.product && !(await Product.exists(scoped(account, { _id: trigger.product })))) {
		return "The product this starts from was deleted: pick another";
	}
	const sender = await senderFor(newsletter);
	for (const { step } of listSteps(automation.steps)) {
		const place = describeStepPlace(automation.steps, step);
		if (step.type === "email") {
			if (!step.subject?.trim()) return `${place}: add a subject`;
			if (!hasContent(step.format === "markdown" ? step.markdown : step.html)) return `${place}: add content`;
			const problem = getSendProblem({ campaign: step, newsletter, sender });
			if (problem) return `${place}: ${problem}`;
		} else if (step.type === "set_field" && !(await CustomField.exists(scoped(account, { newsletterId: automation.newsletterId, key: step.field })))) {
			return `${place}: the field ${step.field} was deleted: pick another`;
		} else if (step.type === "branch" && step.segmentId && !(await Segment.exists(scoped(account, { _id: step.segmentId })))) {
			return `${place}: the segment it checks was deleted: pick another`;
		} else if (step.type === "move" && !(await Automation.exists(scoped(account, { _id: step.automation, status: { $ne: "deleted" } })))) {
			return `${place}: the automation it moves contacts to was deleted: pick another`;
		}
	}
	return null;
}

// ---- Starting contacts from a segment, a date or a stretch without opens

function utcDay(date) {
	return date.toISOString().slice(0, 10);
}

function shiftDay(day, days) {
	return utcDay(new Date(new Date(`${day}T00:00:00Z`).getTime() + days * DAY_MS));
}

export function isEvaluationDue(automation, now) {
	const { trigger, lastEvaluatedAt, evaluationCursor } = automation;
	if (!SCHEDULED_TRIGGERS.includes(trigger?.type)) return false;
	if (evaluationCursor || !lastEvaluatedAt) return true;
	if (trigger.type === "date_field" || trigger.type === "unengaged") return utcDay(new Date(lastEvaluatedAt)) !== utcDay(now);
	return now.getTime() - new Date(lastEvaluatedAt).getTime() >= SEGMENT_EVALUATION_MINUTES * MINUTE_MS;
}

function toEnrollment(automation, contactId, { cycle, now, isBaseline = false }) {
	const [first] = automation.steps;
	return {
		accountId: automation.accountId,
		automationId: automation._id,
		newsletterId: automation.newsletterId,
		contactId,
		cycle,
		trigger: automation.trigger.type,
		enrolledAt: now,
		...(isBaseline
			? { status: "exited", exitReason: "baseline", exitedAt: now }
			: { status: "active", stepIndex: 0, ...(first && { stepId: first.id }), nextRunAt: now }),
	};
}

// Walks the contacts that match, a page at a time from where the last pass stopped, and starts those who aren't in
// the automation for this cycle. Returns whether the pass reached the end.
async function enrollMatching({ automation, filter, cycle, isBaseline, now, summary }) {
	const { accountId } = automation;
	let cursor = automation.evaluationCursor ?? null;
	let budget = EVALUATION_BUDGET;
	for (;;) {
		const contacts = await Contact.find({ ...filter, ...(cursor && { _id: { $gt: cursor } }) })
			.sort({ _id: 1 })
			.limit(EVALUATION_PAGE)
			.select({ _id: 1 })
			.lean();
		if (contacts.length > 0) {
			const there = new Set(
				(await AutomationEnrollment.find({ accountId, automationId: automation._id, cycle, contactId: { $in: contacts.map(({ _id }) => _id) } })
					.select({ contactId: 1 })
					.lean()).map(({ contactId }) => String(contactId))
			);
			const fresh = contacts.filter(({ _id }) => !there.has(String(_id)));
			await insertIgnoringDuplicates(
				AutomationEnrollment,
				fresh.map(({ _id }) => toEnrollment(automation, _id, { cycle, now, isBaseline }))
			);
			if (!isBaseline) summary.enrolled += fresh.length;
			cursor = String(contacts.at(-1)._id);
			budget -= contacts.length;
		}
		if (contacts.length < EVALUATION_PAGE) return { isDone: true, cursor: null };
		if (budget <= 0) return { isDone: false, cursor };
	}
}

// A contact who was in the segment at the last look and isn't now starts the automation, once for each stay: the pass
// first checks everyone it saw inside (phase a), then notes who is inside now (phase b). Where it stopped is "phase:id".
async function enrollLeavers({ automation, matching, now, summary }) {
	const { accountId, newsletterId } = automation;
	const [savedPhase, savedCursor] = automation.evaluationCursor ? automation.evaluationCursor.split(":") : ["a", null];
	let phase = savedPhase;
	let cursor = savedCursor || null;
	let budget = EVALUATION_BUDGET;
	const stopped = () => ({ isDone: false, cursor: `${phase}:${cursor ?? ""}` });

	if (phase === "a") {
		for (;;) {
			const rows = await AutomationWatch.find({ accountId, automationId: automation._id, ...(cursor && { _id: { $gt: cursor } }) })
				.sort({ _id: 1 })
				.limit(EVALUATION_PAGE)
				.lean();
			if (rows.length > 0) {
				const ids = rows.map(({ contactId }) => contactId);
				const inside = new Set((await Contact.find({ ...matching, _id: { $in: ids } }).select({ _id: 1 }).lean()).map(({ _id }) => String(_id)));
				const left = rows.filter(({ contactId }) => !inside.has(String(contactId)));
				if (left.length > 0) {
					const active = await Contact.find({ accountId, newsletterId, status: "active", _id: { $in: left.map(({ contactId }) => contactId) } })
						.select({ _id: 1 })
						.lean();
					const watchByContact = new Map(left.map((row) => [String(row.contactId), row]));
					await insertIgnoringDuplicates(
						AutomationEnrollment,
						active.map(({ _id }) => toEnrollment(automation, _id, { cycle: `l${watchByContact.get(String(_id))._id}`, now }))
					);
					summary.enrolled += active.length;
					await AutomationWatch.deleteMany({ accountId, automationId: automation._id, _id: { $in: left.map(({ _id }) => _id) } });
				}
				cursor = String(rows.at(-1)._id);
				budget -= rows.length;
			}
			if (rows.length < EVALUATION_PAGE) break;
			if (budget <= 0) return stopped();
		}
		phase = "b";
		cursor = null;
	}

	for (;;) {
		const contacts = await Contact.find({ ...matching, ...(cursor && { _id: { $gt: cursor } }) })
			.sort({ _id: 1 })
			.limit(EVALUATION_PAGE)
			.select({ _id: 1 })
			.lean();
		await insertIgnoringDuplicates(
			AutomationWatch,
			contacts.map(({ _id }) => ({ accountId, automationId: automation._id, contactId: _id }))
		);
		if (contacts.length > 0) cursor = String(contacts.at(-1)._id);
		budget -= contacts.length;
		if (contacts.length < EVALUATION_PAGE) return { isDone: true, cursor: null };
		if (budget <= 0) return stopped();
	}
}

async function pauseAutomation(automation, reason, now = new Date()) {
	const { modifiedCount } = await Automation.updateOne(scoped(automation.accountId, { _id: automation._id, status: "active" }), {
		$set: { status: "paused", pauseReason: reason, pausedAt: now },
	});
	automation.status = "paused";
	if (!modifiedCount) return;
	await sendAlert({
		accountId: automation.accountId,
		key: `automation-paused-${automation._id}`,
		title: "Automation paused",
		detail: `${automation.name}: ${reason}.`,
		path: `/automations/${automation._id}`,
		cooldownMinutes: 1,
	});
}

// Triggers that remember what the first look saw, so that only what changes after activation starts anyone.
const BASELINE_TRIGGERS = ["segment_joined", "segment_left", "unengaged"];

async function evaluateAutomation(automation, now, summary) {
	const { trigger } = automation;
	const base = { accountId: automation.accountId, newsletterId: automation.newsletterId, status: "active" };
	let result;
	if (trigger.type === "segment_joined" || trigger.type === "segment_left") {
		const segment = await Segment.findOne({ accountId: automation.accountId, _id: trigger.segmentId }).lean();
		if (!segment) return pauseAutomation(automation, "The segment this starts from was deleted", now);
		if (segment.buildStatus && segment.buildStatus !== "ready") return;
		const compiled = await compileRulesFor(automation.accountId, segment.rules, now);
		if (trigger.type === "segment_left") {
			result = await enrollLeavers({ automation, matching: { accountId: automation.accountId, newsletterId: automation.newsletterId, ...compiled }, now, summary });
		} else {
			const isBaseline = !automation.baselineAt && !trigger.includeExisting;
			result = await enrollMatching({ automation, filter: { ...base, ...compiled }, cycle: "once", isBaseline, now, summary });
		}
	} else if (trigger.type === "unengaged") {
		const isBaseline = !automation.baselineAt && !trigger.includeExisting;
		const dormant = compileCondition({ type: "engagement", kind: "dormant", days: trigger.days }, now);
		result = await enrollMatching({ automation, filter: { ...base, ...dormant }, cycle: "once", isBaseline, now, summary });
	} else {
		const matchDay = shiftDay(utcDay(now), -(trigger.offsetDays ?? 0));
		const isYearly = trigger.repeat === "yearly";
		const filter = { ...base, [`fields.${trigger.field}`]: isYearly ? { $regex: `-${matchDay.slice(5)}$` } : matchDay };
		result = await enrollMatching({ automation, filter, cycle: isYearly ? utcDay(now).slice(0, 4) : "once", isBaseline: false, now, summary });
	}
	summary.evaluated++;
	await Automation.updateOne(
		scoped(automation.accountId, { _id: automation._id }),
		result.isDone
			? { $set: { lastEvaluatedAt: now, ...(BASELINE_TRIGGERS.includes(trigger.type) && !automation.baselineAt && { baselineAt: now }) }, $unset: { evaluationCursor: 1 } }
			: { $set: { evaluationCursor: result.cursor } }
	);
}

async function evaluateScheduledTriggers(now, summary) {
	const active = await Automation.find({ status: "active" }).setOptions({ crossAccount: true }).lean();
	for (const automation of active.filter((item) => isEvaluationDue(item, now))) {
		try {
			const account = await Account.findById(automation.accountId).select({ status: 1, subscriptionStatus: 1, comp: 1, deletion: 1 }).lean();
			if (!account || getAccountSendProblem(account)) continue;
			await evaluateAutomation(automation, now, summary);
		} catch (error) {
			console.error(`[automations] Could not look for contacts to start ${automation._id}:`, error.message);
		}
	}
}

// ---- Running the steps

async function getRoom(account, now) {
	if (!isCloud()) return Number.POSITIVE_INFINITY;
	const [{ proven, recent }, queued] = await Promise.all([
		getSendVolumes(account, now),
		Message.countDocuments(scoped(account, { kind: "automation", createdAt: { $gte: new Date(now.getTime() - DAY_MS) } })),
	]);
	return Math.max(0, Math.max(DAILY_FLOOR, getAllowance({ proven, day: getWarmupDay(account, now) })) - queued - recent);
}

// An automation as the job holds it: its document and its steps by ID.
function toView(automation) {
	return { automation, steps: automation.steps, index: indexSteps(automation.steps) };
}

// An enrollment in the job's hands: its document, the step it runs next (null when it is done) and the emails it sent in
// this run. A step ID that isn't in the steps any more (they were edited while it waited) falls back to the position it
// had in the main list.
function toEntry(doc, view) {
	const steps = view?.steps ?? [];
	const byId = doc.stepId ? view?.index.get(doc.stepId)?.step : null;
	return { doc, step: byId ?? steps[Math.min(doc.stepIndex ?? 0, steps.length)] ?? null, emails: 0 };
}

// A step ID can be all digits, which a path into a document reads as a place in a list: the keys are never bare.
export const stepCountKey = (stepId) => `s:${stepId}`;
export const pathCountKey = (stepId, index) => `p:${stepId}:${index}`;

function count(ctx, entry, key) {
	const id = String(entry.doc.automationId);
	if (!ctx.counts.has(id)) ctx.counts.set(id, new Map());
	const counts = ctx.counts.get(id);
	counts.set(key, (counts.get(key) ?? 0) + 1);
}

// How many contacts each step has run for, and each path of a branch or split has taken: the automation page's numbers.
async function flushCounts(ctx) {
	for (const [automationId, counts] of ctx.counts) {
		const inc = Object.fromEntries([...counts].map(([key, value]) => [`stepCounts.${key}`, value]));
		await Automation.updateOne(scoped(ctx.account, { _id: automationId }), { $inc: inc }).catch((error) =>
			console.error(`[automations] The step counts of ${automationId} were not saved:`, error.message)
		);
	}
	ctx.counts.clear();
}

async function save(entry, ctx, set = {}, unset = {}) {
	const { doc, step: next } = entry;
	const view = ctx.views.get(String(doc.automationId));
	await AutomationEnrollment.updateOne(
		{ accountId: doc.accountId, _id: doc._id, status: "active" },
		{
			$set: { stepIndex: next ? (view.index.get(next.id)?.index ?? 0) : view.steps.length, ...(next && { stepId: next.id }), ...set },
			$unset: { lockedUntil: 1, ...(!next && { stepId: 1 }), ...unset },
			...(entry.emails > 0 && { $inc: { emailsSent: entry.emails } }),
		}
	);
	entry.emails = 0;
}

async function leave(entry, ctx, status, exitReason) {
	await save(
		entry,
		ctx,
		status === "completed" ? { status, completedAt: ctx.now } : { status, exitReason, exitedAt: ctx.now },
		{ nextRunAt: 1 }
	);
	if (status === "completed") ctx.summary.completed++;
	else ctx.summary.exited++;
}

// It moves again at that time, whatever it was held for.
function park(entry, ctx, until) {
	return save(entry, ctx, { nextRunAt: until });
}

function getStepProblem(ctx, automation, newsletter, step) {
	const key = `${automation._id}:${step.id}`;
	if (!ctx.problems.has(key)) {
		ctx.problems.set(key, ctx.senderFor(newsletter).then((sender) => getSendProblem({ campaign: step, newsletter, sender })));
	}
	return ctx.problems.get(key);
}

async function exitForMessage(entry, ctx, message) {
	const contact = ctx.contacts.get(String(entry.doc.contactId));
	const reason =
		message.status === "suppressed"
			? message.error === UNDELIVERABLE_MESSAGE
				? "undeliverable"
				: (getExitReason(contact, ctx.suppressed.has(message.email)) ?? "suppressed")
			: "failed";
	await leave(entry, ctx, "exited", reason);
}

function logStepFailure(step, contact) {
	return (error) => console.error(`[automations] ${step.type} ${step.tag ?? step.field ?? ""} on ${contact._id} failed:`, error.message);
}

async function setField(ctx, contact, step) {
	const key = String(contact.newsletterId);
	if (!ctx.definitions.has(key)) ctx.definitions.set(key, await listCustomFields(ctx.account, contact.newsletterId));
	const update = buildFieldUpdate(ctx.definitions.get(key), { [step.field]: step.value ?? null });
	if (update.isEmpty) return;
	const after = await Contact.findOneAndUpdate(scoped(ctx.account, { _id: contact._id }), toContactUpdate(update), { returnDocument: "after" }).lean();
	if (!after) return;
	ctx.contacts.set(String(contact._id), after);
	await emitSubscriberUpdated(after, getContactChanges(contact, after));
}

// Whether the contact matches a branch's condition now: its own rules, or the saved segment's as they are today. A
// condition that can't be read counts as not matching, and is logged.
async function matchesBranch(ctx, step, contact) {
	try {
		let rules = step.rules;
		if (step.segmentId) {
			const segment = await Segment.findOne(scoped(ctx.account, { _id: step.segmentId })).select({ rules: 1 }).lean();
			if (!segment) return false;
			rules = segment.rules;
		}
		return await contactMatchesRules(ctx.account, contact.newsletterId, contact._id, rules, ctx.now);
	} catch (error) {
		console.error(`[automations] The branch ${step.id} could not be checked for ${contact._id}:`, error.message);
		return false;
	}
}

async function moveContact(ctx, view, step, contact) {
	const target = await Automation.findOne(
		scoped(ctx.account, { _id: step.automation, newsletterId: view.automation.newsletterId, status: { $in: ["active", "paused"] } })
	).lean();
	if (!target || String(target._id) === String(view.automation._id)) return;
	await enrollContact({ automation: target, contact, trigger: "moved", now: ctx.now });
}

// Runs an enrollment's steps until it has to send an email (returns the message to send), has to wait, or is done.
async function advance(entry, ctx) {
	const { doc } = entry;
	const view = ctx.views.get(String(doc.automationId));
	const automation = view?.automation;
	// Paused or deleted since it was picked: it stays where it is.
	if (!automation || automation.status !== "active") return { kind: "skip" };
	const after = (step) => nextStep(view.index, step.id);
	for (let guard = 0; guard <= MAX_TOTAL_STEPS + 1; guard++) {
		const contact = ctx.contacts.get(String(doc.contactId));
		const exitReason = getExitReason(contact, contact && ctx.suppressed.has(contact.email));
		if (exitReason) {
			await leave(entry, ctx, "exited", exitReason);
			return { kind: "done" };
		}
		const step = entry.step;
		if (!step || step.type === "end") {
			if (step) count(ctx, entry, stepCountKey(step.id));
			entry.step = null;
			await leave(entry, ctx, "completed", null);
			return { kind: "done" };
		}
		if (step.type === "wait") {
			count(ctx, entry, stepCountKey(step.id));
			entry.step = after(step);
			const until = isDurationWait(step) ? new Date(ctx.now.getTime() + getWaitMs(step)) : getWaitUntil(step, ctx.now);
			if (until <= ctx.now) continue;
			await park(entry, ctx, until);
			return { kind: "done" };
		}
		if (step.type === "add_tag" || step.type === "remove_tag") {
			const change = step.type === "add_tag" ? addTags : removeTags;
			await change(ctx.account, contact, [step.tag]).catch(logStepFailure(step, contact));
			count(ctx, entry, stepCountKey(step.id));
			entry.step = after(step);
			continue;
		}
		if (step.type === "set_field") {
			await setField(ctx, contact, step).catch(logStepFailure(step, contact));
			count(ctx, entry, stepCountKey(step.id));
			entry.step = after(step);
			continue;
		}
		if (step.type === "webhook") {
			await emitWebhookEvent({
				accountId: doc.accountId,
				newsletterId: doc.newsletterId,
				type: "automation.step",
				data: () => toAutomationStepData({ automation, step, enrollment: doc, contact }),
			});
			count(ctx, entry, stepCountKey(step.id));
			entry.step = after(step);
			continue;
		}
		if (step.type === "branch" || step.type === "split") {
			const path =
				step.type === "branch"
					? (await matchesBranch(ctx, step, contact))
						? 0
						: 1
					: pickSplitPath(
							step.paths.map(({ percent }) => percent),
							getSplitSeed(step, doc.contactId)
						);
			count(ctx, entry, stepCountKey(step.id));
			count(ctx, entry, pathCountKey(step.id, path));
			entry.step = step.paths[path].steps[0] ?? null;
			continue;
		}
		if (step.type === "move") {
			await moveContact(ctx, view, step, contact).catch(logStepFailure(step, contact));
			count(ctx, entry, stepCountKey(step.id));
			entry.step = null;
			await leave(entry, ctx, "completed", null);
			return { kind: "done" };
		}

		const existing = await Message.findOne({ accountId: doc.accountId, enrollmentId: doc._id, stepId: step.id }).lean();
		if (existing && SENT_STATUSES.has(existing.status)) {
			entry.step = after(step);
			continue;
		}
		if (existing && existing.status !== "queued") {
			await exitForMessage(entry, ctx, existing);
			return { kind: "done" };
		}
		if (existing) return { kind: "email", message: existing };

		const newsletter = ctx.newsletters.get(String(doc.newsletterId));
		if (!newsletter) {
			await leave(entry, ctx, "exited", "failed");
			return { kind: "done" };
		}
		const problem = await getStepProblem(ctx, automation, newsletter, step);
		if (problem) {
			await pauseAutomation(automation, problem, ctx.now);
			return { kind: "skip" };
		}
		if (ctx.room <= 0) {
			await park(entry, ctx, new Date(ctx.now.getTime() + PARK_HELD_MS));
			ctx.summary.parked++;
			return { kind: "done" };
		}
		ctx.room--;
		const message = await createMessage({ doc, step, contact });
		return { kind: "email", message };
	}
	return { kind: "skip" };
}

async function createMessage({ doc, step, contact }) {
	const fields = {
		kind: "automation",
		accountId: doc.accountId,
		automationId: doc.automationId,
		enrollmentId: doc._id,
		stepId: step.id,
		newsletterId: doc.newsletterId,
		contactId: contact._id,
		email: contact.email,
		provider: mailboxProvider(contact.email),
	};
	try {
		await Message.create(fields);
	} catch (error) {
		if (error?.code !== 11000) throw error;
	}
	return Message.findOne({ accountId: doc.accountId, enrollmentId: doc._id, stepId: step.id }).lean();
}

// After the batch went through the sending path: what happened to this contact's email.
async function settle(entry, message, ctx) {
	const view = ctx.views.get(String(entry.doc.automationId));
	const fresh = await Message.findOne({ accountId: message.accountId, _id: message._id }).lean();
	if (fresh && SENT_STATUSES.has(fresh.status)) {
		count(ctx, entry, stepCountKey(entry.step.id));
		entry.step = nextStep(view.index, entry.step.id);
		entry.emails++;
		ctx.summary.sent++;
		return true;
	}
	if (fresh && fresh.status !== "queued") {
		await exitForMessage(entry, ctx, fresh);
		return false;
	}
	// Still queued: the account, the plan or the provider said not now. It goes again later with the same message.
	ctx.heldBack++;
	ctx.summary.parked++;
	await park(entry, ctx, new Date(ctx.now.getTime() + PARK_HELD_MS));
	return false;
}

async function alertIfPlanUsedUp(ctx) {
	if (ctx.heldBack === 0) return;
	// The month's count as the sends of this run left it.
	const account = await Account.findById(ctx.account._id).lean();
	if (!account || !areWelcomeEmailsPaused(account, ctx.now)) return;
	await sendAlert({
		accountId: ctx.account._id,
		key: "automations-plan-limit",
		title: "Automations are waiting for your emails to reset",
		detail: "This month's emails are used up, so automated emails wait. They go out when your emails reset, or as soon as you upgrade.",
		path: "/billing",
		cooldownMinutes: 24 * 60,
	});
}

async function loadContext(account, entries, now, summary) {
	const automationIds = [...new Set(entries.map(({ automationId }) => String(automationId)))];
	const contactIds = [...new Set(entries.map(({ contactId }) => String(contactId)))];
	const newsletterIds = [...new Set(entries.map(({ newsletterId }) => String(newsletterId)))];
	const [automations, contacts, newsletters] = await Promise.all([
		Automation.find(scoped(account, { _id: { $in: automationIds } })).lean(),
		Contact.find(scoped(account, { _id: { $in: contactIds } })).lean(),
		Newsletter.find(scoped(account, { _id: { $in: newsletterIds } })).lean(),
	]);
	const suppressed = new Set(await Suppression.distinct("email", { accountId: account._id, email: { $in: contacts.map(({ email }) => email) } }));
	return {
		account,
		now,
		summary,
		views: new Map(automations.map((item) => [String(item._id), toView(item)])),
		contacts: new Map(contacts.map((item) => [String(item._id), item])),
		newsletters: new Map(newsletters.map((item) => [String(item._id), item])),
		suppressed,
		senderFor: createSenderCache(account),
		problems: new Map(),
		definitions: new Map(),
		counts: new Map(),
		room: await getRoom(account, now),
		heldBack: 0,
	};
}

async function processAccount(accountId, docs, now, summary) {
	const account = await Account.findById(accountId).lean();
	if (!account) return;
	const problem = isSendingEnabled() ? getAccountSendProblem(account) : { message: "Sending is off" };
	if (problem) {
		// Blocked, without a plan, or sending off: nobody moves, and they are looked at again later.
		await AutomationEnrollment.updateMany(
			{ accountId: account._id, _id: { $in: docs.map(({ _id }) => _id) }, status: "active" },
			{ $set: { nextRunAt: new Date(now.getTime() + PARK_ACCOUNT_MS) }, $unset: { lockedUntil: 1 } }
		);
		summary.parked += docs.length;
		return;
	}
	const ctx = await loadContext(account, docs, now, summary);
	try {
		let active = docs.map((doc) => toEntry(doc, ctx.views.get(String(doc.automationId))));

		for (let round = 0; round < MAX_ROUNDS && active.length > 0; round++) {
			const pending = [];
			const released = [];
			for (const entry of active) {
				const outcome = await advance(entry, ctx);
				if (outcome.kind === "email") pending.push({ entry, message: outcome.message });
				if (outcome.kind === "skip") released.push(entry);
			}
			await releaseLocks(released);
			if (pending.length === 0) {
				active = [];
				break;
			}
			for (const batch of chunk(pending, MAX_BATCH_MESSAGES)) {
				await sendMessageBatch({ accountId: String(account._id), messageIds: batch.map(({ message }) => String(message._id)) });
			}
			active = [];
			for (const { entry, message } of pending) if (await settle(entry, message, ctx)) active.push(entry);
		}
		// More steps than a run goes through: they continue at the next one.
		for (const entry of active) await save(entry, ctx, { nextRunAt: now });
		await alertIfPlanUsedUp(ctx);
	} finally {
		await flushCounts(ctx);
	}
}

function releaseLocks(entries) {
	if (entries.length === 0) return null;
	return Promise.all(
		entries.map(({ doc }) => AutomationEnrollment.updateOne({ accountId: doc.accountId, _id: doc._id }, { $unset: { lockedUntil: 1 } }))
	);
}

async function claimDue(now, limit) {
	const [notRunning, blocked] = await Promise.all([
		Automation.find({ status: "paused" }).setOptions({ crossAccount: true }).select({ _id: 1 }).lean(),
		Account.find({ status: { $in: IN_USE_ACCOUNT_STATUSES } }).select({ _id: 1 }).lean(),
	]);
	const due = await AutomationEnrollment.find({
		status: "active",
		nextRunAt: { $lte: now },
		$or: [{ lockedUntil: null }, { lockedUntil: { $lt: now } }],
		...(notRunning.length > 0 && { automationId: { $nin: notRunning.map(({ _id }) => _id) } }),
		...(blocked.length > 0 && { accountId: { $nin: blocked.map(({ _id }) => _id) } }),
	})
		.setOptions({ crossAccount: true })
		.sort({ nextRunAt: 1 })
		.limit(limit + 1)
		.lean();
	const claimed = [];
	for (const doc of due.slice(0, limit)) {
		const { modifiedCount } = await AutomationEnrollment.updateOne(
			{ accountId: doc.accountId, _id: doc._id, status: "active", $or: [{ lockedUntil: null }, { lockedUntil: { $lt: now } }] },
			{ $set: { lockedUntil: new Date(now.getTime() + LOCK_MS) } }
		);
		if (modifiedCount) claimed.push(doc);
	}
	return { claimed, hasMore: due.length > limit };
}

// What the QStash job runs: looks for contacts to start from segments and dates, then moves the enrollments that are
// due, a batch at a time. Safe to run again at once or in parallel: an enrollment is held while one run works on it, a
// contact enters an automation once, and an email is one message per enrollment and step.
export async function runAutomations({ now = new Date(), limit = DEFAULT_LIMIT } = {}) {
	await connectDb();
	const summary = { evaluated: 0, enrolled: 0, processed: 0, sent: 0, parked: 0, completed: 0, exited: 0, hasMore: false };
	await evaluateScheduledTriggers(now, summary);
	const { claimed, hasMore } = await claimDue(now, limit);
	summary.processed = claimed.length;
	summary.hasMore = hasMore;
	const byAccount = Map.groupBy(claimed, ({ accountId }) => String(accountId));
	for (const [accountId, docs] of byAccount) {
		try {
			await processAccount(accountId, docs, now, summary);
		} catch (error) {
			// The contacts stay held until the lock runs out, and the rest of the accounts go on.
			console.error(`[automations] Account ${accountId} failed:`, error);
		}
	}
	return summary;
}

// ---- What the dashboard and the API show

export async function countEnrollments(account, automationId) {
	const base = { automationId };
	const [active, completed, exitedAll, baseline] = await Promise.all([
		AutomationEnrollment.countDocuments(scoped(account, { ...base, status: "active" })),
		AutomationEnrollment.countDocuments(scoped(account, { ...base, status: "completed" })),
		AutomationEnrollment.countDocuments(scoped(account, { ...base, status: "exited" })),
		AutomationEnrollment.countDocuments(scoped(account, { ...base, status: "exited", exitReason: "baseline" })),
	]);
	return { active, completed, exited: exitedAll - baseline };
}

export async function ensureAutomationRoom(account, newsletterId) {
	const count = await Automation.countDocuments(scoped(account, { newsletterId, status: { $ne: "deleted" } }));
	if (count >= MAX_AUTOMATIONS_PER_NEWSLETTER) {
		throw actionError("validation_failed", `A newsletter has up to ${MAX_AUTOMATIONS_PER_NEWSLETTER} automations`);
	}
}

export const MAX_HAND_ENROLMENTS = 100;
const MAX_LISTED = 20;

// Starts an active automation for the contacts with these addresses: a manual or API trigger. notFound and notActive
// list the addresses that couldn't start (up to 20), alreadyIn the ones that were in it before.
export async function enrollByHand(account, automation, emails) {
	const addresses = [...new Set(emails.map((email) => normalizeEmail(email)).filter(Boolean))];
	const contacts = await Contact.find(scoped(account, { newsletterId: automation.newsletterId, email: { $in: addresses } })).lean();
	const byEmail = new Map(contacts.map((contact) => [contact.email, contact]));
	const result = { enrolled: 0, alreadyIn: 0, notFound: [], notActive: [] };
	const now = new Date();
	for (const email of addresses) {
		const contact = byEmail.get(email);
		if (!contact) result.notFound.push(email);
		else if (contact.status !== "active") result.notActive.push(email);
		else if (await enrollContact({ automation, contact, now })) result.enrolled++;
		else result.alreadyIn++;
	}
	result.notFound = result.notFound.slice(0, MAX_LISTED);
	result.notActive = result.notActive.slice(0, MAX_LISTED);
	return result;
}

// Contacts waiting for each step, by the step's ID.
export async function countWaiting(account, automationId) {
	const rows = await AutomationEnrollment.aggregate([
		{ $match: { accountId: account._id, automationId, status: "active" } },
		{ $group: { _id: "$stepId", waiting: { $sum: 1 } } },
	]);
	return new Map(rows.map(({ _id, waiting }) => [_id, waiting]));
}

// The steps as a flat list in reading order, each with where it sits and the numbers the report shows.
export function listReportSteps(automation, { waiting, messageStats }) {
	const counts = automation.stepCounts ?? {};
	return listSteps(automation.steps).map(({ step, level, parentId, pathIndex }) => ({
		id: step.id,
		type: step.type,
		label: describeStep(step),
		level,
		parentId,
		pathIndex,
		waiting: waiting.get(step.id) ?? 0,
		ran: counts[stepCountKey(step.id)] ?? 0,
		...(step.paths && { pathRuns: step.paths.map((_, index) => counts[pathCountKey(step.id, index)] ?? 0) }),
		stats: messageStats.get(step.id) ?? null,
	}));
}

