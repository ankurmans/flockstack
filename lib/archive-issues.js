// The statuses of an issue that went out, or is going out: the archive shows these.
export const PUBLISHED_STATUSES = ["sending", "paused", "sent"];

export function getIssueDate(issue) {
	return issue?.sentAt || issue?.startedAt || null;
}
