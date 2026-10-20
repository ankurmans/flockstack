const MAX_ISSUES = 50;
const MAX_NOTE = 200;

// One line of plain text: markdown's brackets can't end a link early and nothing starts a new line or a heading.
function line(value) {
	return String(value ?? "")
		.replace(/\s+/g, " ")
		.replaceAll("[", "(")
		.replaceAll("]", ")")
		.trim();
}

function clip(text, limit) {
	return text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text;
}

// llms.txt for a newsletter's website (llmstxt.org): its name and description, its latest issues with their web addresses
// and preview text, and where its feed and sitemap are. Paid issues and issues marked noindex stay out, like they do from the
// sitemap: the file lists what the owner wants found. issues: newest first, as listArchiveIssues returns them.
export function getLlmsTxt({ newsletter, issues, urls, author }) {
	const listed = issues.filter((issue) => issue.audience !== "paid" && !issue.seo?.noindex && issue.archiveSlug).slice(0, MAX_ISSUES);
	const description = line(newsletter.description);
	return [
		`# ${line(newsletter.name)}`,
		description && `> ${description}`,
		author?.name && `Written by ${line(author.name)}.`,
		"## Issues",
		listed.length > 0
			? listed
					.map((issue) => {
						const note = clip(line(issue.seo?.description || issue.previewText), MAX_NOTE);
						return `- [${line(issue.seo?.title || issue.subject) || "Untitled"}](${urls.absolutePost(issue.archiveSlug)})${note ? `: ${note}` : ""}`;
					})
					.join("\n")
			: "No issues yet.",
		"## More",
		[`- [All issues](${urls.siteIndex})`, `- [RSS feed with the full text of each issue](${urls.feed})`, `- [Sitemap](${urls.sitemap})`].join("\n"),
	]
		.filter(Boolean)
		.join("\n\n")
		.concat("\n");
}
