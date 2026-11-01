import "server-only";
import * as z from "zod";
import { SCOPE_CLASSES } from "@/lib/action-scopes";
import { defineAction } from "@/lib/actions/define-action";
import { actionError } from "@/lib/actions/errors";
import { afterCursor, dateOutput, encodeCursor, findNewsletter, idInput, newsletterFilterInput, toIso } from "@/lib/actions/shared";
import { ACTIVITY_PAGE_SIZE, listActivity, listDayCounts } from "@/lib/agent-activity";
import { ACTIVITY_RETENTION_DAYS } from "@/lib/agent-activity-rules";
import { describeAgent } from "@/lib/agent-guard";
import { APPROVAL_TTL_HOURS, MAX_NOTE_LENGTH } from "@/lib/approval-rules";
import { decideApproval, getApproval, listApprovals, setAgentApproval, toApprovalView } from "@/lib/approvals";
import { ACTIVITY_STATUSES } from "@/models/AgentActivity";
import { APPROVAL_STATUSES, EXECUTION_STATES } from "@/models/ApprovalRequest";

const GROUP = "Agent safety";

const ActorSchema = z.object({
	type: z.enum(["key", "app"]).describe("key: an API key. app: an app connected with OAuth."),
	id: z.string(),
	name: z.string().describe("The key's name, or the app's"),
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
	kind: z.enum(["call", "approval"]),
	actor: ActorSchema,
	via: z.enum(["api", "mcp", "briefing"]).nullable(),
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
		description: `Lists what API keys and connected apps did that changed something or touched contact data, newest first: the action, who, which newsletter, how it ended and a short summary of ids and counts, never the text of an input. It also lists each approval's steps. Kept ${ACTIVITY_RETENTION_DAYS} days. daily counts every call per day, reads included. A key or app sees its own activity; the dashboard's Agent activity page shows everyone's.`,
		http: { method: "GET", path: "/agent-activity" },
		readOnly: true,
		input: z.object({
			actor: z.string().trim().max(100).optional().describe("Only this key's or app's activity: its ID"),
			action: z.string().trim().max(100).optional().describe("Only this action, such as send_campaign"),
			newsletter: newsletterFilterInput,
			status: z.enum(ACTIVITY_STATUSES).optional().describe("Only calls that ended like this"),
			days: z.number().int().min(1).max(ACTIVITY_RETENTION_DAYS).optional().describe(`How many days back, ${ACTIVITY_RETENTION_DAYS} by default`),
			limit: z.number().int().min(1).max(100).optional().describe(`Entries per page, ${ACTIVITY_PAGE_SIZE} by default, 100 at most`),
			cursor: z.string().max(200).optional().describe("nextCursor from the previous page"),
		}),
		output: z.object({
			activity: z.array(ActivitySchema),
			nextCursor: z.string().nullable(),
			daily: z.array(z.object({ day: z.string(), calls: z.number().int(), changes: z.number().int(), denied: z.number().int() })).describe("Calls per UTC day, newest first, for the last 14 days"),
		}),
		handler: async ({ account, apiKey, connection, input }) => {
			const own = getOwnActorId({ apiKey, connection });
			const actorId = own ?? (input.actor || undefined);
			const newsletter = input.newsletter ? await findNewsletter(account, input.newsletter, { _id: 1 }) : null;
			const limit = input.limit ?? ACTIVITY_PAGE_SIZE;
			const { entries, hasMore } = await listActivity(account, {
				actorId,
				action: input.action,
				newsletterId: newsletter?._id,
				status: input.status,
				days: input.days,
				limit,
				after: input.cursor ? afterCursor(input.cursor, "createdAt") : undefined,
			});
			const last = entries.at(-1);
			return {
				activity: entries.map(toActivity),
				nextCursor: hasMore && last ? encodeCursor(last.createdAt, last._id) : null,
				daily: await listDayCounts(account, { actorId }),
			};
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
		}),
		output: z.object({ approval: ApprovalDetailSchema, stale: z.string().nullable().describe("Why nothing was approved: it changed since it was proposed") }),
		handler: async ({ account, user, input }) => {
			const { view, stale } = await decideApproval({ account, user, ...input });
			return { approval: view, stale };
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
			await setAgentApproval(account, newsletter._id, input.required);
			return { newsletterId: String(newsletter._id), required: input.required };
		},
	}),
];
