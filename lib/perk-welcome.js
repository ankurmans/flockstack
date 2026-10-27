import { readerPerks } from "./perk-rules.js";
import { getArchiveUrls } from "./archive-hosts.js";
import { getReaderText } from "./reader-languages.js";
import { escapeText } from "./editor-blocks.js";
export function withWelcomePerks(content, newsletter, contact) {
	const perks = readerPerks(newsletter, contact);
	if (!content || perks.length === 0) return content;
	const label = getReaderText(newsletter)("Subscriber perks");
	const url = getArchiveUrls(newsletter).absolutePerks;
	if (content.format === "markdown") return { ...content, markdown: `${content.markdown ?? ""}\n\n## ${label}\n\n${perks.map(({ title }) => `- ${title.replace(/[\[\]()<>]/g, "")}`).join("\n")}\n\n[${label}](${url})` };
	const section = `<h2>${escapeText(label)}</h2><ul>${perks.map(({ title }) => `<li>${escapeText(title)}</li>`).join("")}</ul><p><a href="${escapeText(url)}">${escapeText(label)}</a></p>`;
	const html = content.html ?? "";
	return { ...content, html: /<\/body\s*>/i.test(html) ? html.replace(/<\/body\s*>/i, `${section}</body>`) : html + section };
}
