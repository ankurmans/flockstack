// The Briefing issue pattern for apply_editorial_pattern (docs/CONTENT-CALENDAR.md, Patterns): the sectioned skeleton a briefing
// writes, for an issue written by hand or by an agent. Generic for any topic: each section's id is its icon's key
// (lib/section-icons.js), and the list has the shape of a briefing's sections, so update_briefing takes it as it is. Plain
// JavaScript with no imports: the actions, the dashboard's pattern form and the tests read it.
export const ISSUE_PATTERNS = ["briefing"];

export const BRIEFING_ISSUE_SECTIONS = [
	{ id: "lead", title: "Lead", format: "sentences", maxItems: 1, priority: 1, purpose: "The story that matters most to readers today: what happened, who it involves and the number that matters" },
	{ id: "market-pulse", title: "Market pulse", format: "one-liners", maxItems: 5, purpose: "Prices, indexes, rates and other numbers that moved, each with how much" },
	{ id: "earnings", title: "Earnings and filings", format: "one-liners", maxItems: 6, purpose: "Results, guidance and official filings, each with the figure that matters" },
	{ id: "roundup", title: "Headline roundup", format: "one-liners", maxItems: 8, purpose: "Other news worth knowing that fits no other section" },
	{ id: "deal-flow", title: "Deal flow", format: "one-liners", maxItems: 6, purpose: "Acquisitions, investments, funding rounds and partnerships, with the parties and the amount when it is public" },
	{ id: "regulation", title: "Regulation and rates", format: "one-liners", maxItems: 5, purpose: "Rules, rulings, consultations and official rate decisions: who decided and what changes" },
	{ id: "people", title: "People moves", format: "one-liners", maxItems: 5, purpose: "Hires, departures and appointments, with the person, the role and the organization" },
	{ id: "launches", title: "Product and tech launches", format: "one-liners", maxItems: 5, purpose: "New products, features and tools: who launched them and what they do" },
	{ id: "coming-up", title: "Coming up", format: "one-liners", maxItems: 5, purpose: "Dated events ahead (reports, meetings, deadlines), the date first" },
];
export const BRIEFING_ISSUE_SECTION_IDS = BRIEFING_ISSUE_SECTIONS.map(({ id }) => id);

const RULES = "Every item names its source. Bold the company, person or product a line is about. Delete a section with nothing in it, heading included.";
const SOURCE = "([Source](https://example.com/the-original))";
const SAMPLE = {
	lead: `What happened, who it involves and the number that matters, in a sentence or two. ${SOURCE}`,
	"coming-up": `- **Date**: the event, and who holds it. ${SOURCE}`,
};

// The sections of the pattern, in reading order: all of them, or the ones named, in the order named.
export function getBriefingIssueSections(ids = null) {
	const copy = (section) => ({ priority: null, ...section });
	if (!ids?.length) return BRIEFING_ISSUE_SECTIONS.map(copy);
	const byId = new Map(BRIEFING_ISSUE_SECTIONS.map((section) => [section.id, section]));
	return [...new Set(ids)].filter((id) => byId.has(id)).map((id) => copy(byId.get(id)));
}

// The skeleton as Markdown, for an item's body: each section a heading, what belongs in it, and one line in its format.
export function getBriefingIssueMarkdown(sections = BRIEFING_ISSUE_SECTIONS) {
	const parts = [`_${RULES}_`];
	for (const { id, title, purpose, format, maxItems } of sections) {
		const shape = format === "sentences" ? `${maxItems === 1 ? "One story" : `Up to ${maxItems} stories`}, a sentence or two each` : `Up to ${maxItems} items, one line each`;
		parts.push(`## ${title}`, `_${purpose}. ${shape}._`, SAMPLE[id] ?? (format === "sentences" ? SAMPLE.lead : `- **Entity** what changed, with the number. ${SOURCE}`));
	}
	return parts.join("\n\n");
}

// What apply_editorial_pattern answers for a pattern with an issue: the sections (ready for update_briefing's sections) and the
// skeleton an item is given.
export function getIssueSkeleton(pattern) {
	if (pattern?.issue !== "briefing") return null;
	const sections = getBriefingIssueSections(pattern.sections);
	return { pattern: "briefing", sections, markdown: getBriefingIssueMarkdown(sections) };
}
