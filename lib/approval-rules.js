import crypto from "node:crypto";

// The approval queue's fixed numbers and shapes (lib/approvals.js). Plain, so the docs and the tests read them.
export const APPROVAL_TTL_HOURS = 24;
// Past these a caller is told to wait: a runaway agent can't fill the queue.
export const MAX_PENDING_PER_ACTOR = 10;
export const MAX_PENDING_PER_ACCOUNT = 50;
// What a request can hold. A bigger one (an import of thousands of rows) is done in the dashboard.
export const MAX_INPUT_BYTES = 1_000_000;
export const MAX_RESULT_BYTES = 20_000;
// A decided request keeps its inputs and result this long; its hash and summary go with the 90 days.
export const DECIDED_INPUT_DAYS = 7;
export const RETRY_AFTER_SECONDS = 30;
export const APPROVAL_NOTIFY_COOLDOWN_MINUTES = 15;
export const MAX_NOTE_LENGTH = 500;
// Same path as lib/api/rest.js's API_BASE_PATH + /approvals: kept here so this module needs nothing.
export const APPROVAL_STATUS_PATH = "/api/v1/approvals";

// Object keys in order, so the same input always hashes the same.
export function canonicalize(value) {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.keys(value)
				.sort()
				.filter((key) => value[key] !== undefined)
				.map((key) => [key, canonicalize(value[key])])
		);
	}
	return value;
}

// What a person approves is the action and its input; this is the proof that neither changed after.
export function hashApprovalInput(action, input) {
	return crypto.createHash("sha256").update(JSON.stringify({ action, input: canonicalize(input ?? {}) })).digest("hex");
}

export function getPendingKey({ actorId, action, inputHash }) {
	return `${actorId}:${action}:${inputHash}`;
}

// A pending request past its time is expired whether or not the hourly sweep has marked it yet.
export function getApprovalStatus(approval, now = new Date()) {
	if (approval.status === "pending" && new Date(approval.expiresAt).getTime() <= now.getTime()) return "expired";
	return approval.status;
}

export function isApprovalRequired(output) {
	return output?.status === "approval_required" && typeof output.approvalId === "string";
}

export function getStatusUrl(appUrl, id) {
	return `${appUrl}${APPROVAL_STATUS_PATH}/${id}`;
}

// What the caller gets instead of the action's result.
export function buildApprovalRequired(approval, appUrl) {
	return {
		status: "approval_required",
		approvalId: String(approval._id),
		action: approval.action,
		summary: approval.summary,
		statusUrl: getStatusUrl(appUrl, approval._id),
		retryAfter: RETRY_AFTER_SECONDS,
		expiresAt: new Date(approval.expiresAt).toISOString(),
		message:
			"A person has to approve this before it runs. It is waiting on FlockStack's Approvals page and has not been done. Do not send it again: poll get_approval_status (GET statusUrl) every retryAfter seconds or more, or wait for the approval.decided webhook, and continue once it says approved.",
	};
}

// What the approval needs shown to its owner when the target changed since the proposal.
export function describeStaleness(before, now) {
	if (!before) return null;
	if (!now) return "The thing this would change is gone.";
	const changes = [];
	if (before.status !== now.status) changes.push(`its status is now ${now.status}`);
	if (before.updatedAt !== now.updatedAt) changes.push("it was edited");
	return changes.length > 0 ? `Since it was proposed, ${changes.join(" and ")}.` : null;
}
