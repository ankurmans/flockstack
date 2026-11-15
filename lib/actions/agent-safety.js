import "server-only";
import * as z from "zod";
import { SCOPE_CLASSES } from "@/lib/action-scopes";
import { defineAction } from "@/lib/actions/define-action";
import { actionError } from "@/lib/actions/errors";
import { afterCursor, dateOutput, encodeCursor, findNewsletter, idInput, newsletterFilterInput, toIso } from "@/lib/actions/shared";
import { ACTIVITY_PAGE_SIZE, describePerson, listActivity, listActivityForExport, listDayCounts, recordActivity, setActivityRetention } from "@/lib/agent-activity";
import {
	ACTIVITY_EXPORT_LIMIT,
	ACTIVITY_PURGE_PER_RUN,
	ACTIVITY_RETENTION_CHOICES,
	ACTIVITY_RETENTION_DAYS,
	MAX_ACTIVITY_RETENTION_DAYS,
	getRetentionDays,
	toActivityCsv,
} from "@/lib/agent-activity-rules";
import { describeAgent } from "@/lib/agent-guard";
import { APPROVAL_TTL_HOURS, MAX_NOTE_LENGTH, STEP_UP_CLASSES, STEP_UP_CODE_MINUTES, STEP_UP_MAX_ATTEMPTS } from "@/lib/approval-rules";
import { decideApproval, getApproval, listApprovals, setAgentApproval, toApprovalView } from "@/lib/approvals";
import Account from "@/models/Account";
import { ACTIVITY_KINDS, ACTIVITY_STATUSES, ACTIVITY_VIAS, ACTOR_TYPES } from "@/models/AgentActivity";
import { APPROVAL_STATUSES, EXECUTION_STATES } from "@/models/ApprovalRequest";

const GROUP = "Agent safety";

const ActorSchema = z.object({
	type: z.enum(["key", "app"]).describe("key: an API key. app: an app connected with OAuth."),
	id: z.string(),
	name: z.string().describe("The key's name, or the app's"),
});

const ActivityActorSchema = z.object({
	type: z.enum(ACTOR_TYPES).describe("key: an API key. app: an app connected with OAuth. person: someone signed in to the dashboard, a team member or the owner."),
	id: z.string(),
	name: z.string().describe("The key's name, the app's (the client), or the person's name and role, never an email"),
});

const PreviewSchema = z.object({
	title: z.string(),
	lines: z.array(z.array(z.string())).describe("[label, value] pairs: what would happen, in plain words"),
	links: z.array(z.object({ label: z.string(), href: z.string() })).describe("Pages in the dashboard to look at, such as the draft"),
});

const ApprovalSchema = z.object({
	id: z.string(),
	status: z.enum(APPROVAL_STATUSES).describe(`pending: waiting for the owner. approved: the owner said yes (executed says whether it ran). rejected: the owner said no. expired: nobody decided in ${APPROVAL_TTL_HOURS} hours. Nothing runs unless approved.`),
	action: z.string().describe("The action that was asked for, such as send_campaign"),
	className: z.enum(SCOPE_CLASSES),
	summary: z.string(),
	preview: PreviewSchema.nullable(),
	newsletterId: z.string().nullable(),
	actor: ActorSchema,
	via: z.enum(["api", "mcp", "briefing"]),
	reason: z.enum(["key", "newsletter", "scale"]).describe("key: the key's level sends this to the owner. newsletter: the newsletter asks before an agent sends. scale: too many contacts at once."),
	createdAt: dateOutput,
	expiresAt: dateOutput,
	decidedAt: dateOutput,
	note: z.string().nullable().describe("What the owner wrote when deciding, if anything"),
	executed: z.boolean().describe("The approved action ran and finished"),
	execution: z.object({
		state: z.enum(EXECUTION_STATES).describe("none until approved; running; done; or failed, with error"),
		error: z.object({ code: z.string(), message: z.string() }).nullable(),
	}),
	result: z.record(z.string(), z.unknown()).nullable().describe("What the action answered once it ran: the same object it answers when nothing needs approval"),
	statusUrl: z.string().describe("GET this to read the request again"),
	retryAfter: z.number().int().nullable().describe("Seconds to wait before asking again while it is pending"),
});

const ApprovalDetailSchema = ApprovalSchema.extend({
	input: z.record(z.string(), z.unknown()).nullable().describe("The exact input that was proposed and will run"),
	inputHash: z.string(),
	isScrubbed: z.boolean().describe("The input was removed a week after the decision"),
});

const ActivitySchema = z.object({
	id: z.string(),
	at: dateOutput,
	kind: z.enum(ACTIVITY_KINDS).describe("call: an action. approval: a step of an approval. setting: the owner changed how agents are held or the log is kept."),
	actor: ActivityActorSchema,
	via: z.enum(ACTIVITY_VIAS).nullable(),
	action: z.string(),
	className: z.string().nullable(),
	newsletterId: z.string().nullable(),
	status: z.enum(ACTIVITY_STATUSES),
	errorCode: z.string().nullable(),
	summary: z.string().describe("Ids, options and counts only: never the text of an input or an address"),
	requestId: z.string().nullable(),
	approvalId: z.string().nullable(),
});

function toActivity(row) {
	return {
		id: String(row._id),
		at: toIso(row.createdAt),
		kind: row.kind,
		actor: { type: row.actorType, id: row.actorId, name: row.actorName },
		via: row.via ?? null,
		action: row.action,
		className: row.className ?? null,
		newsletterId: row.newsletterId ? String(row.newsletterId) : null,
		status: row.status,
		errorCode: row.errorCode ?? null,
		summary: row.summary,
		requestId: row.requestId ?? null,
		approvalId: row.approvalId ? String(row.approvalId) : null,
	};
}

// A key or an app sees what it asked for itself; the dashboard sees everything.
function getOwnActorId({ apiKey, connection }) {
	return describeAgent({ apiKey, connection })?.id ?? null;
}

const ActivityFilterInput = z.object({
	actor: z.string().trim().max(100).optional().describe("Only this key's, app's or person's activity: its ID"),
	actorType: z.enum(ACTOR_TYPES).optional().describe("Only keys, only connected apps, or only people in the dashboard"),
	client: z.string().trim().max(100).optional().describe("Only this client: the key's name, the app's name (such as Claude) or the person, exactly as actor.name shows it"),
	action: z.string().trim().max(100).optional().describe("Only this action, such as send_campaign"),
	newsletter: newsletterFilterInput,
	status: z.enum(ACTIVITY_STATUSES).optional().describe("Only calls that ended like this"),
	days: z.number().int().min(1).max(MAX_ACTIVITY_RETENTION_DAYS).optional().describe(`How many days back: all the account keeps by default (${ACTIVITY_RETENTION_DAYS} unless the owner chose)`),
});

// The filters a caller may use: a key or app reads its own entries unless it is a key made with auditRead (never by default).
async function readActivityFilters(account, { apiKey, connection, input }) {
	const agent = describeAgent({ apiKey, connection });
	const own = agent && !agent.auditRead ? agent.id : null;
	const newsletter = input.newsletter ? await findNewsletter(account, input.newsletter, { _id: 1 }) : null;
	return {
		actorId: own ?? (input.actor || undefined),
		actorType: input.actorType,
		client: input.client || undefined,
		action: input.action,
		newsletterId: newsletter?._id,
		status: input.status,
		days: Math.min(input.days ?? getRetentionDays(account), getRetentionDays(account)),
	};
}

export const agentSafetyActions = [
	defineAction({
		name: "get_approval_status",
		tryWithoutPlan: true,
		title: "Get an approval's status",
		group: GROUP,
		description: `Reads one request that is waiting for the owner's approval, or was decided: pending, approved, rejected or expired, the owner's note, whether the approved action ran and what it answered. An action that needs approval answers approval_required with this request's ID instead of running; poll here every retryAfter seconds, or wait for the approval.decided webhook. Requests expire after ${APPROVAL_TTL_HOURS} hours. A key or app reads only the requests it made.`,
		http: { method: "GET", path: "/approvals/{id}" },
		readOnly: true,
		input: z.object({ id: idInput("approval request") }),
		output: ApprovalSchema,
		handler: async ({ account, apiKey, connection, input }) => {
			const approval = await getApproval(account, input.id);
			const own = getOwnActorId({ apiKey, connection });
			if (!approval || (own && approval.actorId !== own)) throw actionError("not_found", "Approval not found");
			return toApprovalView(approval);
		},
	}),
	defineAction({
		name: "list_approvals",
		tryWithoutPlan: true,
		title: "List approval requests",
		group: GROUP,
		description: "Lists the requests an agent made that need the owner's approval, newest first, pending ones included. A key or app lists the requests it made itself; the dashboard's Approvals page lists everyone's.",
		http: { method: "GET", path: "/approvals" },
		readOnly: true,
		input: z.object({
			status: z.enum(APPROVAL_STATUSES).optional().describe("Only requests in this state. Default: all."),
			limit: z.number().int().min(1).max(100).optional().describe("How many, 50 by default, 100 at most"),
		}),
		output: z.object({ approvals: z.array(ApprovalSchema) }),
		handler: async ({ account, apiKey, connection, input }) => ({
			approvals: (await listApprovals(account, { status: input.status, actorId: getOwnActorId({ apiKey, connection }), limit: input.limit ?? 50 })).map((approval) => toApprovalView(approval)),
		}),
	}),
	defineAction({
		name: "list_agent_activity",
		tryWithoutPlan: true,
		title: "List agent activity",
		group: GROUP,
		description: `Lists what API keys and connected apps did that changed something or touched contact data, newest first: the action, who, which newsletter, how it ended and a short summary of ids and counts, never the text of an input. It also lists each approval's steps, what team members changed in the dashboard and the owner's changes to how agents are held. Kept ${ACTIVITY_RETENTION_DAYS} days unless the owner chose ${ACTIVITY_RETENTION_CHOICES.join(", ")}. daily counts every call per day, reads included. A key or app sees its own activity, unless it is a key made with auditRead; the dashboard's Agent activity page shows everyone's.`,
		http: { method: "GET", path: "/agent-activity" },
		readOnly: true,
		input: ActivityFilterInput.extend({
			limit: z.number().int().min(1).max(100).optional().describe(`Entries per page, ${ACTIVITY_PAGE_SIZE} by default, 100 at most`),
			cursor: z.string().max(200).optional().describe("nextCursor from the previous page"),
		}),
		output: z.object({
			activity: z.array(ActivitySchema),
			nextCursor: z.string().nullable(),
			daily: z.array(z.object({ day: z.string(), calls: z.number().int(), changes: z.number().int(), denied: z.number().int() })).describe("Calls per UTC day, newest first, for the last 14 days"),
		}),
		handler: async ({ account, apiKey, connection, input }) => {
			const filters = await readActivityFilters(account, { apiKey, connection, input });
			const limit = input.limit ?? ACTIVITY_PAGE_SIZE;
			const { entries, hasMore } = await listActivity(account, { ...filters, limit, after: input.cursor ? afterCursor(input.cursor, "createdAt") : undefined });
			const last = entries.at(-1);
			return {
				activity: entries.map(toActivity),
				nextCursor: hasMore && last ? encodeCursor(last.createdAt, last._id) : null,
				daily: await listDayCounts(account, { actorId: filters.actorId }),
			};
		},
	}),
	defineAction({
		name: "export_agent_activity",
		tryWithoutPlan: true,
		title: "Export agent activity",
		group: GROUP,
		description: `Returns the agent activity log as CSV, newest first, with the same filters as list_agent_activity and the same columns, at most ${ACTIVITY_EXPORT_LIMIT.toLocaleString("en-US")} rows: isTruncated says there were more, so export a shorter range. Cells that start with = + - or @ are prefixed with ' so a spreadsheet doesn't run them. A key or app exports its own activity, unless it is a key made with auditRead.`,
		http: { method: "GET", path: "/agent-activity/export" },
		readOnly: true,
		input: ActivityFilterInput,
		output: z.object({ csv: z.string().describe("A header line, then one line per entry"), rows: z.number().int(), isTruncated: z.boolean() }),
		handler: async ({ account, apiKey, connection, input }) => {
			const { rows, isTruncated } = await listActivityForExport(account, await readActivityFilters(account, { apiKey, connection, input }));
			return { csv: toActivityCsv(rows.map((row) => ({ ...row, newsletterId: row.newsletterId ? String(row.newsletterId) : null, approvalId: row.approvalId ? String(row.approvalId) : null }))), rows: rows.length, isTruncated };
		},
	}),
	defineAction({
		name: "set_agent_activity_retention",
		tryWithoutPlan: true,
		title: "Set how long agent activity is kept",
		group: GROUP,
		description: `Sets how many days the agent activity log keeps entries: ${ACTIVITY_RETENTION_CHOICES.join(", ")} (${ACTIVITY_RETENTION_DAYS} by default, ${MAX_ACTIVITY_RETENTION_DAYS} at most because the database has a size cap). Entries already kept take the new number, so a shorter one deletes the older ones at the next hourly purge, which removes at most ${ACTIVITY_PURGE_PER_RUN.toLocaleString("en-US")} rows per choice in one run. Only a signed-in person can change it, in the dashboard.`,
		http: { method: "PATCH", path: "/agent-activity/retention" },
		dashboardOnly: true,
		idempotent: true,
		input: z.object({ days: z.union(ACTIVITY_RETENTION_CHOICES.map((days) => z.literal(days))).describe(`One of ${ACTIVITY_RETENTION_CHOICES.join(", ")}`) }),
		output: z.object({ days: z.number().int() }),
		handler: async ({ account, user, input }) => {
			if (!user?.id) throw actionError("forbidden", "Only a signed-in person can change this");
			const days = await setActivityRetention(account, input.days);
			await recordActivity({ ...account, agentActivityRetentionDays: days }, {
				kind: "setting",
				...describePerson(account, user),
				via: "dashboard",
				action: "set_agent_activity_retention",
				className: "admin",
				status: "ok",
				summary: `Keep agent activity: ${days} days`,
			});
			return { days };
		},
	}),
	defineAction({
		name: "decide_approval",
		tryWithoutPlan: true,
		title: "Approve or reject a request",
		group: GROUP,
		description:
			"Approves or rejects something an agent asked to do. Approving runs the stored action once, as the key or app that asked, with the exact input it proposed. Only a signed-in person can do this, in the dashboard: no API key, connected app or MCP tool can, so an agent can never approve its own request. If the thing changed since the request, approving asks again unless acknowledgeChanges is true.",
		http: { method: "POST", path: "/approvals/{id}/decide" },
		dashboardOnly: true,
		idempotent: true,
		whileBlocked: true,
		input: z.object({
			id: idInput("approval request"),
			decision: z.enum(["approve", "reject"]).describe("approve runs it; reject drops it"),
			note: z.string().trim().max(MAX_NOTE_LENGTH).optional().describe("A word for the agent, which reads it with the status"),
			acknowledgeChanges: z.boolean().optional().describe("Approve although the campaign or automation was edited since it was proposed"),
			code: z.string().trim().regex(/^\d{6}$/).optional().describe("With step-up on, the code emailed to the person approving a send or a delete"),
		}),
		output: z.object({
			approval: ApprovalDetailSchema,
			stale: z.string().nullable().describe("Why nothing was approved: it changed since it was proposed"),
			stepUp: z.enum(["code_sent"]).nullable().describe("code_sent: nothing was approved yet; approve again with the code emailed to you"),
		}),
		handler: async ({ account, user, input }) => {
			const { view, stale, stepUp } = await decideApproval({ account, user, ...input });
			return { approval: view, stale, stepUp: stepUp ?? null };
		},
	}),
	defineAction({
		name: "set_approval_step_up",
		tryWithoutPlan: true,
		title: "Ask for a code to approve",
		group: GROUP,
		description: `Turns on or off step-up for approvals: with it on, approving a request in the ${STEP_UP_CLASSES.join(" or ")} class also takes a 6-digit code emailed to the person approving, valid ${STEP_UP_CODE_MINUTES} minutes and ${STEP_UP_MAX_ATTEMPTS} tries. Rejecting never does. Owner only, in the dashboard.`,
		http: { method: "PATCH", path: "/approvals/step-up" },
		dashboardOnly: true,
		idempotent: true,
		input: z.object({ required: z.boolean().describe("true: approving a send or a delete takes a code by email") }),
		output: z.object({ required: z.boolean() }),
		handler: async ({ account, user, input }) => {
			if (!user?.id || String(account.ownerId) !== String(user.id)) throw actionError("forbidden", "Only the account owner can change this");
			await Account.updateOne({ _id: account._id }, { $set: { approvalStepUp: input.required } });
			await recordActivity(account, {
				kind: "setting",
				...describePerson(account, user),
				via: "dashboard",
				action: "set_approval_step_up",
				className: "admin",
				status: "ok",
				summary: `Code by email to approve: ${input.required ? "on" : "off"}`,
			});
			return { required: input.required };
		},
	}),
	defineAction({
		name: "set_agent_approval",
		tryWithoutPlan: true,
		title: "Ask before agents send",
		group: GROUP,
		description:
			"Turns on or off \"ask me before an agent sends\" for a newsletter: with it on, what any API key or connected app does in the send and delete classes waits for the owner's approval on the Approvals page, whatever the key's level. Only a signed-in person can change it, in the dashboard.",
		http: { method: "PATCH", path: "/agent-approval" },
		dashboardOnly: true,
		idempotent: true,
		input: z.object({
			newsletter: z.string().trim().min(1).max(100).describe("The newsletter's ID or slug"),
			required: z.boolean().describe("true: agents ask first. false: a key's own level decides."),
		}),
		output: z.object({ newsletterId: z.string(), required: z.boolean() }),
		handler: async ({ account, user, input }) => {
			if (!user?.id) throw actionError("forbidden", "Only a signed-in person can change this");
			const newsletter = await findNewsletter(account, input.newsletter, { _id: 1 });
			await setAgentApproval(account, newsletter._id, input.required, user);
			return { newsletterId: String(newsletter._id), required: input.required };
		},
	}),
];
