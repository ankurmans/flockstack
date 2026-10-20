// The statuses of an issue that went out, or is going out: the archive shows these.
export const PUBLISHED_STATUSES = ["sending", "paused", "sent"];

// Where an issue goes: both (the default), email only (no web page, nothing on the website), or web only (published
// on the website, no email).
export const PUBLISH_TARGETS = ["both", "email", "web"];

export function getIssueDate(issue) {
	return issue?.sentAt || issue?.startedAt || null;
}

// When the issue's page last changed for a search engine: its date, or the owner's later change to its search settings.
// The sitemap's lastmod and the page's dateModified. Stats and pins don't count: an issue doesn't change with them.
export function getIssueModified(issue) {
	const sent = getIssueDate(issue);
	const changed = issue?.seo?.updatedAt;
	return changed && (!sent || new Date(changed) > new Date(sent)) ? new Date(changed) : sent;
}
