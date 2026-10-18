import "server-only";
import { scoped } from "@/lib/account-scope";
import { areWelcomeEmailsPaused, getAccountSendProblem } from "@/lib/account-state";
import { actionError } from "@/lib/actions/errors";
import { sendAlert } from "@/lib/alerts";
import { getExitReason } from "@/lib/automation-triggers";
import { MAX_STEPS, SEGMENT_EVALUATION_MINUTES, checkSteps, getWaitMs } from "@/lib/automation-rules";
import { getSendVolumes } from "@/lib/campaign-queries";
import { isCloud, isSendingEnabled } from "@/lib/config";
import { connectDb } from "@/lib/db";
import { UNDELIVERABLE_MESSAGE } from "@/lib/global-suppressions";
import { mailboxProvider } from "@/lib/providers";
import { compileRules } from "@/lib/segment-rules";
import { findSegmentByReference } from "@/lib/segments";
import { createSenderCache } from "@/lib/sender";
import { getAllowance, getWarmupDay } from "@/lib/send-spread";
import { sendMessageBatch } from "@/lib/sending";
import { MAX_BATCH_MESSAGES, chunk, getSendProblem } from "@/lib/sending-rules";
import { normalizeTag } from "@/lib/tag-rules";
import { addTags, removeTags } from "@/lib/tags";
import { hasContent } from "@/lib/render-email";
import Account from "@/models/Account";
import Automation from "@/models/Automation";
import AutomationEnrollment from "@/models/AutomationEnrollment";
import Contact from "@/models/Contact";
import CustomField from "@/models/CustomField";
import Message from "@/models/Message";
import Newsletter from "@/models/Newsletter";
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

export async function validateTrigger(account, newsletterId, input) {
	const fail = (message) => actionError("validation_failed", `trigger: ${message}`);
	const tag = input.tag === undefined ? undefined : normalizeTag(input.tag);
	if (input.tag !== undefined && !tag) throw fail("tag isn't a valid tag");
	switch (input.type) {
		case "subscribed":
			return { type: "subscribed", ...(tag && { tag }), ...(input.source?.trim() && { source: input.source.trim() }) };
		case "tag_added":
			if (!tag) throw fail("tag_added needs a tag");
			return { type: "tag_added", tag };
		case "segment_joined": {
			if (!input.segment) throw fail("segment_joined needs a segment");
			const segment = await findSegmentByReference(account, input.segment, newsletterId);
			return { type: "segment_joined", segmentId: String(segment._id), includeExisting: input.includeExisting === true };
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

export function validateSteps(input, { isComplete = false } = {}) {
	const { steps, problem } = checkSteps(input, { isComplete });
	if (problem) throw actionError("validation_failed", problem);
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
	if (trigger.type === "segment_joined" && !(await Segment.exists(scoped(account, { _id: trigger.segmentId })))) {
		return "The segment this starts from was deleted: pick another";
	}
	if (trigger.type === "date_field" && !(await CustomField.exists(scoped(account, { newsletterId: automation.newsletterId, key: trigger.field, type: "date" })))) {
		return `The date field ${trigger.field} was deleted: pick another`;
	}
	for (const [index, step] of automation.steps.entries()) {
		if (step.type !== "email") continue;
		if (!step.subject?.trim()) return `Step ${index + 1}: add a subject`;
		if (!hasContent(step.format === "markdown" ? step.markdown : step.html)) return `Step ${index + 1}: add content`;
		const problem = getSendProblem({ campaign: step, newsletter, sender: await senderFor(newsletter) });
		if (problem) return `Step ${index + 1}: ${problem}`;
	}
	return null;
}

// ---- Starting contacts from a segment or a date

function utcDay(date) {
	return date.toISOString().slice(0, 10);
}

function shiftDay(day, days) {
	return utcDay(new Date(new Date(`${day}T00:00:00Z`).getTime() + days * DAY_MS));
}

export function isEvaluationDue(automation, now) {
	const { trigger, lastEvaluatedAt, evaluationCursor } = automation;
	if (!["segment_joined", "date_field"].includes(trigger?.type)) return false;
	if (evaluationCursor || !lastEvaluatedAt) return true;
	if (trigger.type === "date_field") return utcDay(new Date(lastEvaluatedAt)) !== utcDay(now);
	return now.getTime() - new Date(lastEvaluatedAt).getTime() >= SEGMENT_EVALUATION_MINUTES * MINUTE_MS;
}

async function insertIgnoringDuplicates(documents) {
	if (documents.length === 0) return;
	try {
		await AutomationEnrollment.insertMany(documents, { ordered: false });
	} catch (error) {
		const codes = (error?.writeErrors ?? []).map(({ err, code }) => err?.code ?? code);
		if (!(codes.length > 0 ? codes.every((code) => code === 11000) : error?.code === 11000)) throw error;
	}
}

// Walks the contacts that match, a page at a time from where the last pass stopped, and starts those who aren't in
// the automation for this cycle. Returns whether the pass reached the end.
async function enrollMatching({ automation, filter, cycle, isBaseline, now, summary }) {
	const { accountId, newsletterId } = automation;
	const [first] = automation.steps;
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
				fresh.map(({ _id }) => ({
					accountId,
					automationId: automation._id,
					newsletterId,
					contactId: _id,
					cycle,
					trigger: automation.trigger.type,
					enrolledAt: now,
					...(isBaseline
						? { status: "exited", exitReason: "baseline", exitedAt: now }
						: { status: "active", stepIndex: 0, ...(first && { stepId: first.id }), nextRunAt: now }),
				}))
			);
			if (!isBaseline) summary.enrolled += fresh.length;
			cursor = String(contacts.at(-1)._id);
			budget -= contacts.length;
		}
		if (contacts.length < EVALUATION_PAGE) return { isDone: true, cursor: null };
		if (budget <= 0) return { isDone: false, cursor };
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

async function evaluateAutomation(automation, now, summary) {
	const { trigger } = automation;
	const base = { accountId: automation.accountId, newsletterId: automation.newsletterId, status: "active" };
	let result;
	let isBaseline = false;
	if (trigger.type === "segment_joined") {
		const segment = await Segment.findOne({ accountId: automation.accountId, _id: trigger.segmentId }).lean();
		if (!segment) return pauseAutomation(automation, "The segment this starts from was deleted", now);
		isBaseline = !automation.baselineAt && !trigger.includeExisting;
		result = await enrollMatching({ automation, filter: { ...base, ...compileRules(segment.rules, now) }, cycle: "once", isBaseline, now, summary });
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
			? { $set: { lastEvaluatedAt: now, ...(trigger.type === "segment_joined" && !automation.baselineAt && { baselineAt: now }) }, $unset: { evaluationCursor: 1 } }
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

// An enrollment in the job's hands: its document, where it stands (index into the automation's steps) and the emails
// it sent in this run.
function toEntry(doc, automation) {
	const steps = automation?.steps ?? [];
	const byId = doc.stepId ? steps.findIndex((step) => step.id === doc.stepId) : -1;
	return { doc, index: byId >= 0 ? byId : Math.min(doc.stepIndex ?? 0, steps.length), emails: 0 };
}

async function save(entry, steps, set = {}, unset = {}) {
	const { doc } = entry;
	const next = steps[entry.index];
	await AutomationEnrollment.updateOne(
		{ accountId: doc.accountId, _id: doc._id, status: "active" },
		{
			$set: { stepIndex: entry.index, ...(next && { stepId: next.id }), ...set },
			$unset: { lockedUntil: 1, ...(!next && { stepId: 1 }), ...unset },
			...(entry.emails > 0 && { $inc: { emailsSent: entry.emails } }),
		}
	);
	entry.emails = 0;
}

async function leave(entry, steps, now, status, exitReason, summary) {
	await save(
		entry,
		steps,
		status === "completed" ? { status, completedAt: now } : { status, exitReason, exitedAt: now },
		{ nextRunAt: 1 }
	);
	if (status === "completed") summary.completed++;
	else summary.exited++;
}

// It moves again at that time, whatever it was held for.
function park(entry, steps, until) {
	return save(entry, steps, { nextRunAt: until });
}

function getStepProblem(ctx, automation, newsletter, step) {
	const key = `${automation._id}:${step.id}`;
	if (!ctx.problems.has(key)) {
		ctx.problems.set(key, ctx.senderFor(newsletter).then((sender) => getSendProblem({ campaign: step, newsletter, sender })));
	}
	return ctx.problems.get(key);
}

async function exitForMessage(entry, steps, message, ctx) {
	const contact = ctx.contacts.get(String(entry.doc.contactId));
	const reason =
		message.status === "suppressed"
			? message.error === UNDELIVERABLE_MESSAGE
				? "undeliverable"
				: (getExitReason(contact, ctx.suppressed.has(message.email)) ?? "suppressed")
			: "failed";
	await leave(entry, steps, ctx.now, "exited", reason, ctx.summary);
}

// Runs an enrollment's steps until it has to send an email (returns the message to send), has to wait, or is done.
async function advance(entry, ctx) {
	const { doc } = entry;
	const automation = ctx.automations.get(String(doc.automationId));
	// Paused or deleted since it was picked: it stays where it is.
	if (!automation || automation.status !== "active") return { kind: "skip" };
	const { steps } = automation;
	for (let guard = 0; guard <= MAX_STEPS + 1; guard++) {
		const contact = ctx.contacts.get(String(doc.contactId));
		const exitReason = getExitReason(contact, contact && ctx.suppressed.has(contact.email));
		if (exitReason) {
			await leave(entry, steps, ctx.now, "exited", exitReason, ctx.summary);
			return { kind: "done" };
		}
		const step = steps[entry.index];
		if (!step || step.type === "end") {
			if (step) entry.index = steps.length;
			await leave(entry, steps, ctx.now, "completed", null, ctx.summary);
			return { kind: "done" };
		}
		if (step.type === "wait") {
			entry.index++;
			await park(entry, steps, new Date(ctx.now.getTime() + getWaitMs(step)));
			return { kind: "done" };
		}
		if (step.type === "add_tag" || step.type === "remove_tag") {
			const change = step.type === "add_tag" ? addTags : removeTags;
			await change(ctx.account, contact, [step.tag]).catch((error) => console.error(`[automations] ${step.type} ${step.tag} on ${contact._id} failed:`, error.message));
			entry.index++;
			continue;
		}

		const existing = await Message.findOne({ accountId: doc.accountId, enrollmentId: doc._id, stepId: step.id }).lean();
		if (existing && SENT_STATUSES.has(existing.status)) {
			entry.index++;
			continue;
		}
		if (existing && existing.status !== "queued") {
			await exitForMessage(entry, steps, existing, ctx);
			return { kind: "done" };
		}
		if (existing) return { kind: "email", message: existing };

		const newsletter = ctx.newsletters.get(String(doc.newsletterId));
		if (!newsletter) {
			await leave(entry, steps, ctx.now, "exited", "failed", ctx.summary);
			return { kind: "done" };
		}
		const problem = await getStepProblem(ctx, automation, newsletter, step);
		if (problem) {
			await pauseAutomation(automation, problem, ctx.now);
			return { kind: "skip" };
		}
		if (ctx.room <= 0) {
			await park(entry, steps, new Date(ctx.now.getTime() + PARK_HELD_MS));
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
	const { steps } = ctx.automations.get(String(entry.doc.automationId));
	const fresh = await Message.findOne({ accountId: message.accountId, _id: message._id }).lean();
	if (fresh && SENT_STATUSES.has(fresh.status)) {
		entry.index++;
		entry.emails++;
		ctx.summary.sent++;
		return true;
	}
	if (fresh && fresh.status !== "queued") {
		await exitForMessage(entry, steps, fresh, ctx);
		return false;
	}
	// Still queued: the account, the plan or the provider said not now. It goes again later with the same message.
	ctx.heldBack++;
	ctx.summary.parked++;
	await park(entry, steps, new Date(ctx.now.getTime() + PARK_HELD_MS));
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
		automations: new Map(automations.map((item) => [String(item._id), item])),
		contacts: new Map(contacts.map((item) => [String(item._id), item])),
		newsletters: new Map(newsletters.map((item) => [String(item._id), item])),
		suppressed,
		senderFor: createSenderCache(account),
		problems: new Map(),
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
	let active = docs.map((doc) => toEntry(doc, ctx.automations.get(String(doc.automationId))));

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
	for (const entry of active) {
		const automation = ctx.automations.get(String(entry.doc.automationId));
		await save(entry, automation.steps, { nextRunAt: now });
	}
	await alertIfPlanUsedUp(ctx);
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
