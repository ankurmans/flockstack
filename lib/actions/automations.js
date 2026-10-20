import "server-only";
import * as z from "zod";
import { scoped } from "@/lib/account-scope";
import { getAccountSendProblem } from "@/lib/account-state";
import { defineAction } from "@/lib/actions/define-action";
import { actionError } from "@/lib/actions/errors";
import { assertSendingEnabled, dateOutput, findNewsletter, idInput, newsletterFilterInput, newsletterInput, toIso } from "@/lib/actions/shared";
import { notifyActivity } from "@/lib/alerts";
import {
	MAX_STEPS,
	STEP_FORMATS,
	STEP_TYPES,
	StepSchema,
	TriggerSchema,
	describeStep,
	describeTrigger,
	toStepOutput,
} from "@/lib/automation-rules";
import {
	MAX_AUTOMATIONS_PER_NEWSLETTER,
	countEnrollments,
	ensureAutomationRoom,
	getActivationProblem,
	toTriggerOutput,
	validateSteps,
	validateTrigger,
} from "@/lib/automations";
import { getAppUrl } from "@/lib/config";
import { ensureFreeAutomationRoom } from "@/lib/free-guard";
import { MESSAGE_STATS_GROUP } from "@/lib/message-stats";
import { createSenderCache } from "@/lib/sender";
import Automation, { AUTOMATION_STATUSES } from "@/models/Automation";
import AutomationEnrollment, { EXIT_REASONS } from "@/models/AutomationEnrollment";
import Message from "@/models/Message";
import Segment from "@/models/Segment";

const GROUP = "Automations";
const LISTED_STATUSES = AUTOMATION_STATUSES.filter((status) => status !== "deleted");
const IRREVERSIBLE = "Sending can't be undone: emails can't be recalled once they go out. Ask the user to confirm first.";
const automationId = idInput("automation");
const nameInput = z.string().trim().min(1).max(100).describe("The automation's name, 100 characters at most");
const RATE_KEYS = ["sent", "delivered", "opened", "clicked", "bounced", "complained"];

const StepOutputSchema = z.object({
	id: z.string(),
	type: z.enum(STEP_TYPES),
	subject: z.string().optional(),
	previewText: z.string().optional(),
	format: z.enum(STEP_FORMATS).optional(),
	content: z.string().optional(),
	amount: z.number().int().optional(),
	unit: z.enum(["minutes", "hours", "days"]).optional(),
	tag: z.string().optional(),
});
const EnrollmentCountsSchema = z.object({
	active: z.number().int().describe("Contacts moving through it now"),
	completed: z.number().int().describe("Contacts who reached its end"),
	exited: z.number().int().describe("Contacts who left before the end: they unsubscribed, bounced, were deleted..."),
});
const AutomationSchema = z.object({
	id: z.string(),
	newsletterId: z.string(),
	name: z.string(),
	status: z.enum(LISTED_STATUSES).describe("draft: being written. active: contacts enter and move along. paused: nobody enters or moves, and contacts continue where they were when it's active again."),
	trigger: TriggerSchema,
	steps: z.array(StepOutputSchema),
	summary: z.string().describe("The trigger and steps in words"),
	pauseReason: z.string().nullable().describe("Why it paused itself, when a problem with its emails did: the owner has to fix it, then activate it again"),
	activatedAt: dateOutput,
	dashboardUrl: z.string(),
	createdAt: dateOutput,
	updatedAt: dateOutput,
});
const AutomationWithCountsSchema = AutomationSchema.extend({ enrollments: EnrollmentCountsSchema });

function toAutomation(automation, segmentName) {
	return {
		id: String(automation._id),
		newsletterId: String(automation.newsletterId),
		name: automation.name,
		status: automation.status,
		trigger: toTriggerOutput(automation.trigger),
		steps: automation.steps.map(toStepOutput),
		summary: [describeTrigger(automation.trigger, { segmentName }), ...automation.steps.map(describeStep)].join(" → "),
		pauseReason: automation.pauseReason ?? null,
		activatedAt: toIso(automation.activatedAt),
		dashboardUrl: `${getAppUrl()}/automations/${automation._id}`,
		createdAt: toIso(automation.createdAt),
		updatedAt: toIso(automation.updatedAt),
	};
}

async function findAutomation(account, id) {
	const found = /^[a-f0-9]{24}$/i.test(id) ? await Automation.findOne(scoped(account, { _id: id.toLowerCase() })).lean() : null;
	if (!found || found.status === "deleted") throw actionError("not_found", "Automation not found");
	return found;
}

async function present(account, automation) {
	const segment = automation.trigger.segmentId ? await Segment.findOne(scoped(account, { _id: automation.trigger.segmentId })).select({ name: 1 }).lean() : null;
	return { ...toAutomation(automation, segment?.name), enrollments: await countEnrollments(account, automation._id) };
}

async function reload(account, automation) {
	return present(account, await Automation.findOne(scoped(account, { _id: automation._id })).lean());
}

const listAutomations = defineAction({
	name: "list_automations",
	tryWithoutPlan: true,
	title: "List automations",
	group: GROUP,
	description:
		"Lists a newsletter's automations, newest first, each with its trigger, steps and how many contacts are in it, finished it or left it. An automation sends a series of emails and changes tags for each contact it starts for.",
	http: { method: "GET", path: "/automations" },
	readOnly: true,
	input: z.object({
		newsletter: newsletterFilterInput.describe("The newsletter's ID or slug. Default: the account's first newsletter."),
		status: z.enum(LISTED_STATUSES).optional().describe("Only automations with this status"),
	}),
	output: z.object({ automations: z.array(AutomationWithCountsSchema) }),
	handler: async ({ account, input }) => {
		const newsletter = await findNewsletter(account, input.newsletter, { _id: 1 });
		const automations = await Automation.find(
			scoped(account, { newsletterId: newsletter._id, status: input.status ?? { $ne: "deleted" } })
		)
			.sort({ createdAt: -1, _id: -1 })
			.lean();
		return { automations: await Promise.all(automations.map((automation) => present(account, automation))) };
	},
});

const getAutomation = defineAction({
	name: "get_automation",
	tryWithoutPlan: true,
	title: "Get an automation",
	group: GROUP,
	description: "Gets an automation with its trigger, its steps (emails with their content) and how many contacts are in it.",
	http: { method: "GET", path: "/automations/{id}" },
	readOnly: true,
	input: z.object({ id: automationId }),
	output: AutomationWithCountsSchema,
	handler: async ({ account, input }) => present(account, await findAutomation(account, input.id)),
});

const createAutomation = defineAction({
	name: "create_automation",
	tryWithoutPlan: true,
	title: "Create an automation",
	group: GROUP,
	description: `Creates an automation as a draft: nothing is sent until activate_automation. A trigger starts it for a contact (they subscribe, get a tag, join a segment, or reach a date), and steps run in order: send an email, wait, add or remove a tag, or end. Up to ${MAX_STEPS} steps and ${MAX_AUTOMATIONS_PER_NEWSLETTER} automations a newsletter (2 on the Free plan, on top of the welcome email). A contact enters an automation once. Emails go through the same checks as a campaign's: the account's plan emails, suppression and sending limits, with an unsubscribe link in each.`,
	http: { method: "POST", path: "/automations", status: 201 },
	rateLimit: { limit: 60, window: "1 h" },
	example: {
		name: "Welcome series",
		trigger: { type: "subscribed" },
		steps: [
			{ type: "email", subject: "Welcome", content: "Thanks for joining, {{first_name|friend}}." },
			{ type: "wait", amount: 2, unit: "days" },
			{ type: "email", subject: "Where to start", content: "Here are three issues worth your time." },
		],
	},
	input: z.object({
		newsletter: newsletterInput,
		name: nameInput,
		trigger: TriggerSchema.describe("What starts the automation for a contact"),
		steps: z.array(StepSchema).max(MAX_STEPS).optional().describe("The steps, in order. Default: none yet."),
	}),
	output: AutomationWithCountsSchema,
	handler: async ({ account, input, via }) => {
		const newsletter = await findNewsletter(account, input.newsletter, { _id: 1 });
		await ensureAutomationRoom(account, newsletter._id);
		await ensureFreeAutomationRoom(account);
		const trigger = await validateTrigger(account, newsletter._id, input.trigger);
		const steps = validateSteps(input.steps ?? []);
		const automation = await Automation.create({
			accountId: account._id,
			newsletterId: newsletter._id,
			name: input.name,
			trigger,
			steps,
			source: via === "dashboard" ? "dashboard" : "api",
		});
		return present(account, automation.toObject());
	},
});

const updateAutomation = defineAction({
	name: "update_automation",
	tryWithoutPlan: true,
	title: "Update an automation",
	group: GROUP,
	description:
		"Changes an automation's name, trigger or steps. The trigger and steps of an active automation can't change: pause_automation first, then activate_automation again. Send all the steps, with the IDs you got back for the ones that stay, so contacts waiting on a step remain on it; a step without an ID is new.",
	http: { method: "PATCH", path: "/automations/{id}" },
	idempotent: true,
	example: { name: "Welcome series, shorter" },
	input: z.object({
		id: automationId,
		name: nameInput.optional(),
		trigger: TriggerSchema.optional().describe("The new trigger"),
		steps: z.array(StepSchema).max(MAX_STEPS).optional().describe("All the steps, which replace the old ones"),
	}),
	output: AutomationWithCountsSchema,
	handler: async ({ account, input }) => {
		const automation = await findAutomation(account, input.id);
		const changesParts = input.trigger !== undefined || input.steps !== undefined;
		if (changesParts && automation.status === "active") throw actionError("conflict", "Pause the automation first: an active automation's trigger and steps can't change");
		const set = {
			...(input.name !== undefined && { name: input.name }),
			...(input.trigger !== undefined && { trigger: await validateTrigger(account, automation.newsletterId, input.trigger) }),
			...(input.steps !== undefined && { steps: validateSteps(input.steps) }),
		};
		// A new segment or date starts the first look over, and a segment's old baseline no longer applies.
		const unset = input.trigger !== undefined ? { lastEvaluatedAt: 1, evaluationCursor: 1, baselineAt: 1 } : null;
		if (Object.keys(set).length > 0) {
			await Automation.updateOne(scoped(account, { _id: automation._id, status: { $ne: "deleted" } }), { $set: set, ...(unset && { $unset: unset }) });
		}
		return reload(account, automation);
	},
});

const activateAutomation = defineAction({
	name: "activate_automation",
	title: "Activate an automation",
	group: GROUP,
	description: `Switches an automation on: from now on, contacts the trigger starts for get its emails without anyone asking again, until pause_automation. ${IRREVERSIBLE} The account's plan, from address, postal address and every email's size are checked first, and again as the emails go out. A segment trigger starts only the contacts who join the segment from now on, unless includeExisting is true. Contacts who unsubscribe, bounce or complain leave it.`,
	http: { method: "POST", path: "/automations/{id}/activate" },
	destructive: true,
	idempotent: true,
	openWorld: true,
	rateLimit: { limit: 30, window: "1 h" },
	input: z.object({ id: automationId }),
	output: AutomationWithCountsSchema,
	handler: async ({ account, input }) => {
		const automation = await findAutomation(account, input.id);
		if (automation.status === "active") return reload(account, automation);
		const accountProblem = getAccountSendProblem(account);
		if (accountProblem) throw actionError(accountProblem.code, accountProblem.message);
		assertSendingEnabled();
		const newsletter = await findNewsletter(account, String(automation.newsletterId));
		const problem = await getActivationProblem({ account, automation, newsletter, senderFor: createSenderCache(account) });
		if (problem) throw actionError("send_check_failed", problem);
		const isFirst = !automation.activatedAt;
		const { matchedCount } = await Automation.updateOne(scoped(account, { _id: automation._id, status: { $in: ["draft", "paused"] } }), {
			$set: { status: "active", ...(isFirst && { activatedAt: new Date() }) },
			$unset: { pauseReason: 1, pausedAt: 1, ...(isFirst && { lastEvaluatedAt: 1, evaluationCursor: 1, baselineAt: 1 }) },
		});
		if (!matchedCount) throw actionError("conflict", "The automation changed, refresh and try again");
		await notifyActivity([`Automation activated: ${automation.name}`, `${getAppUrl()}/automations/${automation._id}`], { accountId: account._id });
		return reload(account, automation);
	},
});

const pauseAutomation = defineAction({
	name: "pause_automation",
	tryWithoutPlan: true,
	title: "Pause an automation",
	group: GROUP,
	description: "Stops an active automation: no new contacts enter and none move on, and no emails go out. Contacts in it continue where they were when it's activated again.",
	http: { method: "POST", path: "/automations/{id}/pause" },
	idempotent: true,
	whileBlocked: true,
	input: z.object({ id: automationId }),
	output: AutomationWithCountsSchema,
	handler: async ({ account, input }) => {
		const automation = await findAutomation(account, input.id);
		if (automation.status === "active") {
			await Automation.updateOne(scoped(account, { _id: automation._id, status: "active" }), { $set: { status: "paused", pausedAt: new Date() } });
		} else if (automation.status !== "paused") {
			throw actionError("conflict", "Only an active automation can pause");
		}
		return reload(account, automation);
	},
});

const deleteAutomation = defineAction({
	name: "delete_automation",
	tryWithoutPlan: true,
	title: "Delete an automation",
	group: GROUP,
	description: "Deletes an automation: it leaves every list and the contacts in it are taken out, so nothing more is sent. It can't be undone. Emails already sent stay sent.",
	http: { method: "DELETE", path: "/automations/{id}" },
	destructive: true,
	idempotent: true,
	whileBlocked: true,
	input: z.object({ id: automationId }),
	output: z.object({ id: z.string(), deleted: z.literal(true) }),
	handler: async ({ account, input }) => {
		const automation = await findAutomation(account, input.id);
		await Automation.updateOne(scoped(account, { _id: automation._id }), { $set: { status: "deleted" } });
		await AutomationEnrollment.updateMany(scoped(account, { automationId: automation._id, status: "active" }), {
			$set: { status: "exited", exitReason: "deleted", exitedAt: new Date() },
			$unset: { nextRunAt: 1, lockedUntil: 1 },
		});
		return { id: String(automation._id), deleted: true };
	},
});

const getAutomationReport = defineAction({
	name: "get_automation_report",
	tryWithoutPlan: true,
	title: "Get an automation's report",
	group: GROUP,
	description:
		"How an automation is doing: how many contacts entered, are in it, finished it or left it (and why), and for each step how many contacts wait to run it and, for emails, how many were sent, delivered, opened, clicked, bounced and complained.",
	http: { method: "GET", path: "/automations/{id}/report" },
	readOnly: true,
	rateLimit: { limit: 120, window: "1 h" },
	input: z.object({ id: automationId }),
	output: z.object({
		automation: AutomationWithCountsSchema,
		entered: z.number().int().describe("Contacts the trigger started it for"),
		exits: z.object(Object.fromEntries(EXIT_REASONS.filter((reason) => reason !== "baseline").map((reason) => [reason, z.number().int()]))).describe("Why contacts left before the end"),
		steps: z.array(
			z.object({
				id: z.string(),
				type: z.enum(STEP_TYPES),
				label: z.string(),
				waiting: z.number().int().describe("Contacts in the automation whose next step this is"),
				...Object.fromEntries(RATE_KEYS.map((key) => [key, z.number().int().optional()])),
			})
		),
		rates: z
			.object({ delivered: z.number().nullable(), opened: z.number().nullable(), clicked: z.number().nullable(), bounced: z.number().nullable() })
			.describe("Over all its emails, as fractions from 0 to 1: delivered and bounced of sent; opened and clicked of delivered"),
	}),
	handler: async ({ account, input }) => {
		const automation = await findAutomation(account, input.id);
		const { _id } = automation;
		const [shown, exitCounts, waiting, stats] = await Promise.all([
			present(account, automation),
			Promise.all(
				EXIT_REASONS.filter((reason) => reason !== "baseline").map((reason) =>
					AutomationEnrollment.countDocuments(scoped(account, { automationId: _id, status: "exited", exitReason: reason }))
				)
			),
			Promise.all(automation.steps.map((step) => AutomationEnrollment.countDocuments(scoped(account, { automationId: _id, status: "active", stepId: step.id })))),
			Message.aggregate([
				{ $match: { accountId: account._id, automationId: _id, kind: "automation" } },
				{ $group: { _id: "$stepId", ...MESSAGE_STATS_GROUP } },
			]),
		]);
		const byStep = new Map(stats.map(({ _id: id, ...counts }) => [id, counts]));
		const total = Object.fromEntries(RATE_KEYS.map((key) => [key, stats.reduce((sum, row) => sum + (row[key] ?? 0), 0)]));
		const rate = (part, whole) => (whole ? Math.round((part / whole) * 10_000) / 10_000 : null);
		const reached = total.delivered || total.sent;
		return {
			automation: shown,
			entered: shown.enrollments.active + shown.enrollments.completed + shown.enrollments.exited,
			exits: Object.fromEntries(EXIT_REASONS.filter((reason) => reason !== "baseline").map((reason, index) => [reason, exitCounts[index]])),
			steps: automation.steps.map((step, index) => ({
				id: step.id,
				type: step.type,
				label: describeStep(step),
				waiting: waiting[index],
				...(step.type === "email" && Object.fromEntries(RATE_KEYS.map((key) => [key, byStep.get(step.id)?.[key] ?? 0]))),
			})),
			rates: {
				delivered: rate(total.delivered, total.sent),
				opened: rate(total.opened, reached),
				clicked: rate(total.clicked, reached),
				bounced: rate(total.bounced, total.sent),
			},
		};
	},
});

export const automationActions = [
	listAutomations,
	getAutomation,
	createAutomation,
	updateAutomation,
	activateAutomation,
	pauseAutomation,
	deleteAutomation,
	getAutomationReport,
];
