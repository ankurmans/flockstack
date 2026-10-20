// The statuses of an issue that went out, or is going out: the archive shows these.
export const PUBLISHED_STATUSES = ["sending", "paused", "sent"];

// Where an issue goes: both (the default), email only (no web page, nothing on the website), or web only (published
// on the website, no email).
export const PUBLISH_TARGETS = ["both", "email", "web"];

export function getIssueDate(issue) {
	return issue?.sentAt || issue?.startedAt || null;
}
