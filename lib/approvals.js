import "server-only";
import { scoped } from "@/lib/account-scope";
import { actionError } from "@/lib/actions/errors";
import { recordActivity } from "@/lib/agent-activity";
import {
	APPROVAL_NOTIFY_COOLDOWN_MINUTES,
	APPROVAL_TTL_HOURS,
	MAX_INPUT_BYTES,
	MAX_NOTE_LENGTH,
	MAX_PENDING_PER_ACCOUNT,
	MAX_PENDING_PER_ACTOR,
	MAX_RESULT_BYTES,
	RETRY_AFTER_SECONDS,
	buildApprovalRequired,
	describeStaleness,
	getApprovalStatus,
	getPendingKey,
	getStatusUrl,
	hashApprovalInput,
} from "@/lib/approval-rules";
import { buildPreview, getFingerprint } from "@/lib/approval-preview";
import { getAppUrl } from "@/lib/config";
import { toApprovalData } from "@/lib/webhook-events";
import { isObjectIdString } from "@/lib/validation";
import ApprovalRequest from "@/models/ApprovalRequest";
import ApiKey from "@/models/ApiKey";
import Newsletter from "@/models/Newsletter";

// A briefing's own sends ask as this kind of app (lib/briefings-delivery.js).
export const BRIEFING_ACTOR_PREFIX = "briefing:";

// lib/webhooks.js reaches the sending code and the AWS clients: loaded when an event is sent, not with every call of the guard.
const emitWebhookEvent = async (...args) => (await import("@/lib/webhooks")).emitWebhookEvent(...args);

// The approval queue: an agent's SEND and DESTRUCTIVE actions wait here for a person (lib/agent-guard.js decides which).
// A request is stored with its exact input and the input's hash, which nothing changes. Approving runs the action once, as the
// key or app that asked, with that stored input; rejecting or letting it expire runs nothing.

function toIso(value) {
	return value ? new Date(value).toISOString() : null;
}

// Results can be big (a list); the agent gets the first 20 KB and is told when there's more.
function capResult(output) {
	const text = JSON.stringify(output ?? null);
	return text.length <= MAX_RESULT_BYTES ? output : { truncated: true, message: "The result is too long to keep here. Read the changed thing with its own get action." };
}

// What the agent and the dashboard see. includeInput: the dashboard's page, which shows the exact input.
export function toApprovalView(approval, { includeInput = false, now = new Date() } = {}) {
	const status = getApprovalStatus(approval, now);
	const execution = approval.execution ?? {};
	return {
		id: String(approval._id),
		status,
		action: approval.action,
		className: approval.className,
		summary: approval.summary,
		preview: approval.preview ?? null,
		newsletterId: approval.newsletterId ? String(approval.newsletterId) : null,
		actor: { type: approval.actorType, id: approval.actorId, name: approval.actorName },
		via: approval.via,
		reason: approval.reason,
		createdAt: toIso(approval.createdAt),
		expiresAt: toIso(approval.expiresAt),
		decidedAt: toIso(approval.decidedAt),
		note: approval.note ?? null,
		executed: execution.state === "done",
		execution: {
			state: execution.state ?? "none",
			error: execution.errorCode ? { code: execution.errorCode, message: execution.errorMessage ?? "" } : null,
		},
		result: execution.state === "done" ? (execution.result ?? null) : null,
		statusUrl: getStatusUrl(getAppUrl(), approval._id),
		retryAfter: status === "pending" ? RETRY_AFTER_SECONDS : null,
		...(includeInput && { input: approval.input ?? null, inputHash: approval.inputHash, isScrubbed: Boolean(approval.scrubbedAt) }),
	};
}

async function expireOne(account, approval, reason = null) {
	const { matchedCount } = await ApprovalRequest.updateOne(scoped(account, { _id: approval._id, status: "pending" }), {
		$set: { status: "expired", decidedAt: new Date(), ...(reason && { note: reason }) },
		$unset: { pendingKey: 1 },
	});
	if (matchedCount) await announceDecision(account, approval._id, "expired");
	return matchedCount > 0;
}

// After a decision (or an expiry): the log, and the webhook with the outcome.
async function announceDecision(account, id, status) {
	const approval = await ApprovalRequest.findOne(scoped(account, { _id: id })).lean();
	if (!approval) return;
	await recordActivity(account, {
		kind: "approval",
		actorType: approval.actorType,
		actorId: approval.actorId,
		actorName: approval.actorName,
		via: approval.via,
		action: approval.action,
		className: approval.className,
		newsletterId: approval.newsletterId,
		status,
		summary: `${approval.summary}: ${status}`.slice(0, 240),
		requestId: approval.requestId,
		approvalId: approval._id,
	});
	await emitWebhookEvent({ accountId: account._id, newsletterId: approval.newsletterId, type: "approval.decided", data: () => ({ approval: toApprovalData(approval) }) });
}

async function notifyOwner(account, approval) {
	// Loaded here: alerts send email (the AWS clients), which almost no call of the guard needs.
	const { sendAlert } = await import("@/lib/alerts");
	await sendAlert({
		accountId: account._id,
		key: "agent-approvals",
		title: `${approval.actorName} is waiting for your approval`,
		detail: `${approval.summary}.`,
		action: "Nothing has happened yet. Review it on the Approvals page, then approve or reject it. It expires in 24 hours.",
		path: "/approvals",
		cooldownMinutes: APPROVAL_NOTIFY_COOLDOWN_MINUTES,
	});
}

async function findPending(account, filter, now) {
	return ApprovalRequest.countDocuments(scoped(account, { ...filter, status: "pending", expiresAt: { $gt: now } }));
}

// Stores the request, tells the owner, and answers what the agent gets in place of the action's result. A request identical to a
// pending one of the same caller is that one: asking twice doesn't make two.
export async function proposeApproval({ account, agent, action, className, input, newsletterId, via, requestId, reason, summary }) {
	const now = new Date();
	if (JSON.stringify(input ?? {}).length > MAX_INPUT_BYTES) {
		throw actionError("validation_failed", "This is too big to wait for approval. Send it in smaller parts, or do it in the dashboard.");
	}
	const inputHash = hashApprovalInput(action.name, input);
	const pendingKey = getPendingKey({ actorId: agent.id, action: action.name, inputHash });
	const existing = await ApprovalRequest.findOne(scoped(account, { pendingKey })).lean();
	if (existing) {
		if (new Date(existing.expiresAt) > now) return buildApprovalRequired(existing, getAppUrl());
		await expireOne(account, existing);
	}
	if ((await findPending(account, { actorId: agent.id }, now)) >= MAX_PENDING_PER_ACTOR || (await findPending(account, {}, now)) >= MAX_PENDING_PER_ACCOUNT) {
		throw actionError("conflict", "Too many requests are already waiting for the owner's approval. Wait for them to be decided before asking for more.");
	}

	const [preview, fingerprint] = await Promise.all([buildPreview(account, action, input), getFingerprint(account, action.name, input)]);
	let created;
	try {
		created = await ApprovalRequest.create({
			accountId: account._id,
			...(newsletterId && { newsletterId }),
			actorType: agent.type,
			actorId: agent.id,
			actorName: agent.name,
			preset: agent.preset,
			via,
			action: action.name,
			className,
			reason,
			input,
			inputHash,
			summary,
			preview,
			fingerprint,
			requestId,
			pendingKey,
			expiresAt: new Date(now.getTime() + APPROVAL_TTL_HOURS * 3_600_000),
		});
	} catch (error) {
		if (error?.code !== 11000) throw error;
		return buildApprovalRequired(await ApprovalRequest.findOne(scoped(account, { pendingKey })).lean(), getAppUrl());
	}
	const approval = created.toObject();
	await recordActivity(account, {
		kind: "approval",
		actorType: agent.type,
		actorId: agent.id,
		actorName: agent.name,
		via,
		action: action.name,
		className,
		newsletterId,
		status: "proposed",
		summary: `${summary}: waiting for approval`.slice(0, 240),
		requestId,
		approvalId: approval._id,
	});
	await notifyOwner(account, approval);
	return buildApprovalRequired(approval, getAppUrl());
}

export async function getApproval(account, id) {
	if (!isObjectIdString(id)) return null;
	return ApprovalRequest.findOne(scoped(account, { _id: id })).lean();
}

// Newest first. actorId limits it to one caller's: what an API key or an app sees.
export async function listApprovals(account, { status, actorId, limit = 50 } = {}) {
	const now = new Date();
	// Pending past its time is expired whether or not the sweep has marked it, so the filters read both columns.
	const filter = {
		...(actorId && { actorId }),
		...(status === "pending" && { status: "pending", expiresAt: { $gt: now } }),
		...(status === "expired" && { $or: [{ status: "expired" }, { status: "pending", expiresAt: { $lte: now } }] }),
		...(status && !["pending", "expired"].includes(status) && { status }),
	};
	return ApprovalRequest.find(scoped(account, filter)).sort({ createdAt: -1, _id: -1 }).limit(limit).lean();
}

export async function countPendingApprovals(account) {
	return findPending(account, {}, new Date());
}

// Whether the target of a pending request changed since it was proposed: a sentence to show the owner, or null.
export async function getStaleness(account, approval) {
	if (!approval.fingerprint || approval.status !== "pending") return null;
	return describeStaleness(approval.fingerprint, await getFingerprint(account, approval.action, approval.input));
}

// The key or app that asked, as it is now: a revoked key, an expired one or a disconnected app can't have its request run.
async function loadIdentity(account, approval) {
	if (approval.actorType === "key") {
		const apiKey = isObjectIdString(approval.actorId) ? await ApiKey.findOne(scoped(account, { _id: approval.actorId })).lean() : null;
		if (!apiKey || apiKey.revokedAt || (apiKey.expiresAt && new Date(apiKey.expiresAt) <= new Date())) return null;
		return { apiKey };
	}
	// A briefing that sends by itself asks as an app named briefing:<id>; it stands as long as the briefing does and still sends by itself.
	if (approval.actorType === "app" && String(approval.actorId).startsWith(BRIEFING_ACTOR_PREFIX)) {
		const id = String(approval.actorId).slice(BRIEFING_ACTOR_PREFIX.length);
		const { default: Briefing } = await import("@/models/Briefing");
		const briefing = isObjectIdString(id) ? await Briefing.findOne(scoped(account, { _id: id })).select({ _id: 1 }).lean() : null;
		return briefing ? {} : null;
	}
	const { getConnection } = await import("@/lib/oauth");
	const connection = await getConnection(account, approval.actorId);
	return connection ? { connection } : null;
}

async function execute(account, approval) {
	const fail = async (code, message) => {
		await ApprovalRequest.updateOne(scoped(account, { _id: approval._id }), {
			$set: { "execution.state": "failed", "execution.at": new Date(), "execution.errorCode": code, "execution.errorMessage": String(message).slice(0, 500) },
		});
		return "execution_failed";
	};
	// The stored input is what was approved: if it doesn't hash to what the owner saw, nothing runs.
	if (hashApprovalInput(approval.action, approval.input) !== approval.inputHash) return fail("conflict", "The stored request doesn't match its hash, so it was not run.");
	const identity = await loadIdentity(account, approval);
	if (!identity) return fail("unauthorized", "The key or app that asked is no longer valid, so it was not run.");
	try {
		const { runAction } = await import("@/lib/actions/run-action");
		const output = await runAction(approval.action, {
			account,
			input: approval.input,
			via: approval.via,
			requestId: approval.requestId,
			approvalId: String(approval._id),
			...identity,
		});
		await ApprovalRequest.updateOne(scoped(account, { _id: approval._id }), {
			$set: { "execution.state": "done", "execution.at": new Date(), "execution.result": capResult(output) },
		});
		return "executed";
	} catch (error) {
		return fail(error?.isActionError || error?.code ? error.code : "internal_error", error?.message ?? "It failed.");
	}
}

// decision: approve or reject. Safe to repeat: the first decision wins, and a second one of the same kind answers with the
// state as it is. A change to the thing since it was proposed stops an approval unless acknowledgeChanges says the owner saw it.
export async function decideApproval({ account, user, id, decision, note, acknowledgeChanges = false }) {
	if (!user?.id) throw actionError("forbidden", "Only a signed-in person can decide an approval");
	const approval = await getApproval(account, id);
	if (!approval) throw actionError("not_found", "Approval not found");
	const now = new Date();
	const text = typeof note === "string" ? note.trim().slice(0, MAX_NOTE_LENGTH) : "";
	const wanted = decision === "approve" ? "approved" : "rejected";

	if (approval.status === "pending" && new Date(approval.expiresAt) <= now) {
		await expireOne(account, approval);
		return { view: toApprovalView(await getApproval(account, id), { includeInput: true }), stale: null };
	}
	if (approval.status !== "pending") {
		if (approval.status !== wanted) throw actionError("conflict", `This request was already ${approval.status}.`);
		return { view: toApprovalView(approval, { includeInput: true }), stale: null };
	}

	const stale = decision === "approve" ? await getStaleness(account, approval) : null;
	if (stale && !acknowledgeChanges) return { view: toApprovalView(approval, { includeInput: true }), stale };

	// Only one request can win this: the others find it no longer pending.
	const { matchedCount } = await ApprovalRequest.updateOne(scoped(account, { _id: approval._id, status: "pending", expiresAt: { $gt: now } }), {
		$set: {
			status: wanted,
			decidedAt: now,
			decidedBy: String(user.id),
			...(text && { note: text }),
			...(decision === "approve" && { "execution.state": "running", "execution.at": now }),
		},
		$unset: { pendingKey: 1 },
	});
	if (!matchedCount) {
		const current = await getApproval(account, id);
		return { view: toApprovalView(current, { includeInput: true }), stale: null };
	}
	const outcome = decision === "approve" ? await execute(account, approval) : wanted;
	await announceDecision(account, approval._id, wanted);
	if (outcome === "executed" || outcome === "execution_failed") {
		const finished = await getApproval(account, id);
		await recordActivity(account, {
			kind: "approval",
			actorType: approval.actorType,
			actorId: approval.actorId,
			actorName: approval.actorName,
			via: approval.via,
			action: approval.action,
			className: approval.className,
			newsletterId: approval.newsletterId,
			status: outcome,
			errorCode: finished.execution?.errorCode,
			summary: `${approval.summary}: ${outcome === "executed" ? "done" : "failed"}`.slice(0, 240),
			requestId: approval.requestId,
			approvalId: approval._id,
		});
	}
	return { view: toApprovalView(await getApproval(account, id), { includeInput: true }), stale: null };
}

// The hourly sweep: requests nobody decided in 24 hours. Bounded; the next run takes the rest.
export async function expireDueApprovals(now = new Date()) {
	const due = await ApprovalRequest.find({ status: "pending", expiresAt: { $lte: now } })
		.setOptions({ crossAccount: true })
		.limit(200)
		.lean();
	let expired = 0;
	for (const approval of due) if (await expireOne({ _id: approval.accountId }, approval)) expired++;
	return expired;
}

// The setting behind "Ask me before an agent sends": dashboard only, so no agent can switch it off.
export async function setAgentApproval(account, newsletterId, required) {
	const { matchedCount } = await Newsletter.updateOne(scoped(account, { _id: newsletterId }), { $set: { agentApproval: Boolean(required) } });
	if (!matchedCount) throw actionError("not_found", "Newsletter not found");
}
