import { getIssueContentHtml } from "@/lib/archive-content";
import { splitAtPaywall } from "@/lib/editor-blocks";
import { htmlToMarkdown } from "@/lib/html-to-markdown";

// Public Markdown has the same paywall boundary as the page, even for raw HTML issues.
export function getArchiveMarkdown(issue, { gatedHtml = null } = {}) {
	const campaign = issue.format === "html" ? { ...issue, html: splitAtPaywall(issue.html ?? "").before } : issue;
	const body = htmlToMarkdown(gatedHtml ?? getIssueContentHtml(campaign));
	const title = String(issue.subject ?? "").replace(/[\r\n]/g, " ").replace(/[\\`*_{}[\]<>#]/g, "");
	return issue.kind === "note" ? `${body}\n` : `# ${title}\n\n${body}\n`;
}
