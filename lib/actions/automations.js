import "server-only";
import * as z from "zod";
import { scoped } from "@/lib/account-scope";
import { getAccountSendProblem } from "@/lib/account-state";
import { defineAction } from "@/lib/actions/define-action";
import { actionError } from "@/lib/actions/errors";
import { assertSendingEnabled, dateOutput, findNewsletter, idInput, newsletterFilterInput, newsletterInput, toIso } from "@/lib/actions/shared";
import { notifyActivity } from "@/lib/alerts";
import {
	MAX_NESTING,
	MAX_SPLIT_PATHS,
	MAX_STEPS,
	MAX_TOTAL_STEPS,
	STEP_FORMATS,
	STEP_TYPES,
	StepSchema,
	TriggerSchema,
	WEEKDAYS,
	checkSteps,
	countSteps,
	describeStep,
	describeTrigger,
	toStepOutput,
} from "@/lib/automation-rules";
import { AUTOMATION_TEMPLATES, findAutomationTemplate } from "@/lib/automation-templates";
import {
	MAX_AUTOMATIONS_PER_NEWSLETTER,
	MAX_HAND_ENROLMENTS,
	countEnrollments,
	countWaiting,
	enrollByHand,
	ensureAutomationRoom,
	getActivationProblem,
	listReportSteps,
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
import AutomationWatch from "@/models/AutomationWatch";
import Message from "@/models/Message";
import Product from "@/models/Product";
import Segment from "@/models/Segment";

const GROUP = "Automations";
const LISTED_STATUSES = AUTOMATION_STATUSES.filter((status) => status !== "deleted");
const IRREVERSIBLE = "Sending can't be undone: emails can't be recalled once they go out. Ask the user to confirm first.";
const automationId = idInput("automation");
const nameInput = z.string().trim().min(1).max(100).describe("The automation's name, 100 characters at most");
const RATE_KEYS = ["sent", "delivered", "opened", "clicked", "bounced", "complained"];

// A step as the API shows it. Paths nest as far as the input does, written out for the same reason (StepSchema).
function makeStepOutputSchema(depth) {
	const shape = {
		id: z.string(),
		type: z.enum(STEP_TYPES),
		subject: z.string().optional(),
		previewText: z.string().optional(),
		format: z.enum(STEP_FORMATS).optional(),
		content: z.string().optional(),
		amount: z.number().int().optional(),
		unit: z.enum(["minutes", "hours", "days"]).optional(),
		until: z.string().optional().describe("wait: the date and time it waits for"),
		weekday: z.enum(WEEKDAYS).optional(),
		time: z.string().optional(),
		timeZone: z.string().optional(),
		tag: z.string().optional(),
		field: z.string().optional(),
		value: z.union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.null()]).optional(),
		name: z.string().optional(),
		condition: z.record(z.string(), z.unknown()).optional().describe("branch: the rules, as create_segment takes them"),
		segment: z.string().optional().describe("branch: the saved segment's ID"),
		seed: z.string().optional(),
		automation: z.string().optional().describe("move: the ID of the automation contacts move to"),
	};
	if (depth > 0) {
		shape.paths = z
			.array(z.object({ name: z.string().optional(), percent: z.number().int().optional(), steps: z.array(makeStepOutputSchema(depth - 1)) }))
			.optional();
	}
	return z.object(shape);
}
const StepOutputSchema = makeStepOutputSchema(MAX_NESTING - 1);
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

function toAutomation(automation, names) {
	return {
		id: String(automation._id),
		newsletterId: String(automation.newsletterId),
		name: automation.name,
		status: automation.status,
		trigger: toTriggerOutput(automation.trigger),
		steps: automation.steps.map(toStepOutput),
		summary: [describeTrigger(automation.trigger, names), ...automation.steps.map(describeStep)].join(" → "),
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
	const { trigger } = automation;
	const [segment, product] = await Promise.all([
		trigger.segmentId ? Segment.findOne(scoped(account, { _id: trigger.segmentId })).select({ name: 1 }).lean() : null,
		trigger.product ? Product.findOne(scoped(account, { _id: trigger.product })).select({ title: 1 }).lean() : null,
	]);
	return { ...toAutomation(automation, { segmentName: segment?.name, productTitle: product?.title }), enrollments: await countEnrollments(account, automation._id) };
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
		"Lists a newsletter's automations, newest first, each with its trigger, steps and how many contacts are in it, finished it or left it. An automation sends emails and changes tags, fields and webhooks for each contact it starts for, with waits, branches and random splits between.",
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
	description: `Creates an automation as a draft: nothing is sent until activate_automation. A trigger starts it for a contact: they subscribe, get or lose a tag, join or leave a segment, reach a date, change a custom field, upgrade or drop to free, buy a product, have a referral credited, go unengaged for days, click a link in an issue, or you add them by hand (manual) or from your code (api, with enroll_contacts). Steps run in order: send an email, wait (a duration, until a date and time, or until a weekday), add or remove a tag, set a custom field, send an automation.step event to your webhook endpoints, move the contact to another automation, or end. A branch ends its list with two paths, by whether the contact matches a condition (rules like a segment's, or a saved segment); a split ends it with 2 to ${MAX_SPLIT_PATHS} paths by percent, chosen at random per contact. Paths hold steps of their own and nest ${MAX_NESTING} lists deep. Up to ${MAX_STEPS} steps in a list, ${MAX_TOTAL_STEPS} in all, and ${MAX_AUTOMATIONS_PER_NEWSLETTER} automations a newsletter (2 on the Free plan, on top of the welcome email). A contact enters an automation once, except for purchases, referral credits, upgrades, downgrades and leaving a segment, which start it again each time. Emails go through the same checks as a campaign's: the account's plan emails, suppression and sending limits, with an unsubscribe link in each. create_automation_from_template starts from a ready-made one.`,
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
		const steps = await validateSteps(account, newsletter._id, input.steps ?? []);
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
		"Changes an automation's name, trigger or steps. The trigger and steps of an active automation can't change: pause_automation first, then activate_automation again. Send all the steps, paths included, with the IDs you got back for the ones that stay, so contacts waiting on a step remain on it, whatever moves around it; a step without an ID is new.",
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
			...(input.steps !== undefined && { steps: await validateSteps(account, automation.newsletterId, input.steps, { selfId: automation._id }) }),
		};
		// A new segment or date starts the first look over, and a segment's old baseline no longer applies.
		const unset = input.trigger !== undefined ? { lastEvaluatedAt: 1, evaluationCursor: 1, baselineAt: 1 } : null;
		if (Object.keys(set).length > 0) {
			await Automation.updateOne(scoped(account, { _id: automation._id, status: { $ne: "deleted" } }), { $set: set, ...(unset && { $unset: unset }) });
		}
		if (input.trigger !== undefined) await AutomationWatch.deleteMany(scoped(account, { automationId: automation._id }));
		return reload(account, automation);
	},
});

const activateAutomation = defineAction({
	name: "activate_automation",
	title: "Activate an automation",
	group: GROUP,
	description: `Switches an automation on: from now on, contacts the trigger starts for get its emails without anyone asking again, until pause_automation. ${IRREVERSIBLE} The account's plan, from address, postal address and every email's size are checked first, and again as the emails go out. A segment or unengaged trigger starts only the contacts who join the segment or go unengaged from now on, unless includeExisting is true. Contacts who unsubscribe, bounce or complain leave it.`,
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
		await AutomationWatch.deleteMany(scoped(account, { automationId: automation._id }));
		return { id: String(automation._id), deleted: true };
	},
});

const getAutomationReport = defineAction({
	name: "get_automation_report",
	tryWithoutPlan: true,
	title: "Get an automation's report",
	group: GROUP,
	description:
		"How an automation is doing: how many contacts entered, are in it, finished it or left it (and why), and for each step, in reading order with its place in the tree, how many contacts wait to run it, how many it has run for, and how many took each path of a branch or split; for emails, how many were sent, delivered, opened, clicked, bounced and complained.",
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
				level: z.number().int().describe("1 for the main list of steps, 2 for the paths of a branch or split in it, and so on"),
				parentId: z.string().nullable().describe("The branch or split this step is in a path of; null in the main list"),
				pathIndex: z.number().int().nullable().describe("Which of that step's paths, from 0: for a branch 0 is the contacts who matched"),
				waiting: z.number().int().describe("Contacts in the automation whose next step this is"),
				ran: z.number().int().describe("Contacts the step has run for: an email sent, a wait begun, a tag or field changed, a branch or split decided"),
				pathRuns: z.array(z.number().int()).optional().describe("branch, split: how many contacts took each path, in order"),
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
			countWaiting(account, _id),
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
			steps: listReportSteps(automation, { waiting, messageStats: byStep }).map(({ stats: emailStats, ...step }) => ({
				...step,
				...(step.type === "email" && Object.fromEntries(RATE_KEYS.map((key) => [key, emailStats?.[key] ?? 0]))),
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

const enrollContacts = defineAction({
	name: "enroll_contacts",
	tryWithoutPlan: true,
	title: "Add contacts to an automation",
	group: GROUP,
	description: `Starts an active automation whose trigger is manual (you add contacts from the dashboard) or api (your code adds them) for up to ${MAX_HAND_ENROLMENTS} contacts of its newsletter, by email address. A contact enters an automation once: addresses already in it are counted in alreadyIn, and addresses that aren't contacts, or aren't active, are listed and skipped. Nothing is sent by this call itself; the automation's first step runs within a few minutes.`,
	http: { method: "POST", path: "/automations/{id}/enroll" },
	rateLimit: { limit: 120, window: "1 h" },
	openWorld: true,
	example: { emails: ["jane@example.com"] },
	input: z.object({
		id: automationId,
		emails: z.array(z.string().trim().max(320)).min(1).max(MAX_HAND_ENROLMENTS).describe(`The contacts' email addresses, up to ${MAX_HAND_ENROLMENTS}`),
	}),
	output: z.object({
		enrolled: z.number().int().describe("Contacts it started for now"),
		alreadyIn: z.number().int().describe("Contacts that were in it already"),
		notFound: z.array(z.string()).describe("Addresses that aren't contacts of the newsletter (the first 20)"),
		notActive: z.array(z.string()).describe("Contacts that aren't active, so can't get emails (the first 20)"),
	}),
	handler: async ({ account, input }) => {
		const automation = await findAutomation(account, input.id);
		if (!["manual", "api"].includes(automation.trigger.type)) {
			throw actionError("conflict", `This automation starts when ${describeTrigger(automation.trigger).toLowerCase()}: give it the manual or api trigger to add contacts yourself`);
		}
		if (automation.status !== "active") throw actionError("conflict", "Activate the automation first: only an active one takes contacts");
		return enrollByHand(account, automation, input.emails);
	},
});

const TemplateSchema = z.object({
	id: z.string().describe("Pass it to create_automation_from_template"),
	name: z.string(),
	description: z.string(),
	trigger: TriggerSchema,
	steps: z.number().int().describe("How many steps it has, paths included"),
	summary: z.string().describe("The trigger and steps in words"),
});

function toTemplate(template) {
	const { steps } = checkSteps(template.steps);
	const trigger = template.trigger;
	return {
		id: template.id,
		name: template.name,
		description: template.description,
		trigger,
		steps: countSteps(steps),
		summary: [describeTrigger(trigger), ...steps.map(describeStep)].join(" → "),
	};
}

const listAutomationTemplates = defineAction({
	name: "list_automation_templates",
	tryWithoutPlan: true,
	title: "List automation templates",
	group: GROUP,
	description: "Lists the ready-made automations create_automation_from_template starts from: a welcome series, re-engagement, paid onboarding, a product buyer thank-you and referral thanks, each with its trigger and what it does.",
	http: { method: "GET", path: "/automation-templates" },
	readOnly: true,
	input: z.object({}),
	output: z.object({ templates: z.array(TemplateSchema) }),
	handler: async () => ({ templates: AUTOMATION_TEMPLATES.map(toTemplate) }),
});

const createAutomationFromTemplate = defineAction({
	name: "create_automation_from_template",
	tryWithoutPlan: true,
	title: "Create an automation from a template",
	group: GROUP,
	description: "Creates a draft automation from a template of list_automation_templates, with its trigger, steps and email text ready to edit with update_automation. Nothing is sent until activate_automation, and its emails need the same checks (a subject, content, the newsletter's sender and postal address) to pass first. Read the text before activating: it is a starting point, written to be changed.",
	http: { method: "POST", path: "/automations/from-template", status: 201 },
	rateLimit: { limit: 60, window: "1 h" },
	example: { template: "welcome-series" },
	input: z.object({
		newsletter: newsletterInput,
		template: z.enum(AUTOMATION_TEMPLATES.map(({ id }) => id)).describe("The template's id"),
		name: nameInput.optional().describe("The automation's name. Default: the template's."),
	}),
	output: AutomationWithCountsSchema,
	handler: async ({ account, input, via }) => {
		const template = findAutomationTemplate(input.template);
		const newsletter = await findNewsletter(account, input.newsletter, { _id: 1 });
		await ensureAutomationRoom(account, newsletter._id);
		await ensureFreeAutomationRoom(account);
		const trigger = await validateTrigger(account, newsletter._id, template.trigger);
		const steps = await validateSteps(account, newsletter._id, template.steps);
		const automation = await Automation.create({
			accountId: account._id,
			newsletterId: newsletter._id,
			name: input.name ?? template.automationName,
			trigger,
			steps,
			source: via === "dashboard" ? "dashboard" : "api",
		});
		return present(account, automation.toObject());
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
	enrollContacts,
	listAutomationTemplates,
	createAutomationFromTemplate,
];
