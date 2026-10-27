// The command palette (Cmd/Ctrl+K): the dashboard's pages, one action, and what a search finds. Pure, so a test reads it.
// The palette is a way around the dashboard, not an action of the API: whatever it opens is a page.

// The pages of the sidebar (components/NavLinks.jsx) and the account's, with other words people may type for them.
export const PAGES = [
	{ href: "/", label: "Overview", keywords: "home dashboard stats" },
	{ href: "/assistant", label: "Account assistant", keywords: "ai chat agent drafts segments approvals cmd j" },
	{ href: "/campaigns", label: "Campaigns", keywords: "issues newsletters emails drafts sent" },
	{ href: "/campaigns/calendar", label: "Calendar", keywords: "schedule content plan month" },
	{ href: "/reports", label: "Reports", keywords: "growth analytics sources utm channels website visits csv compare issues" },
	{ href: "/contacts", label: "Contacts", keywords: "subscribers audience readers list tags" },
	{ href: "/segments", label: "Segments", keywords: "audiences filters" },
	{ href: "/automations", label: "Automations", keywords: "welcome series workflows" },
	{ href: "/series", label: "Series", keywords: "rss feed recurring schedule" },
	{ href: "/templates", label: "Templates", keywords: "saved layouts snippets" },
	{ href: "/surveys", label: "Surveys", keywords: "questions forms" },
	{ href: "/forms", label: "Forms", keywords: "signup embed popup pop-up magic link gate" },
	{ href: "/referrals", label: "Referrals", keywords: "rewards invite" },
	{ href: "/recommending", label: "Recommendations", keywords: "recommend newsletters grow" },
	{ href: "/comments", label: "Comments", keywords: "moderation discussion" },
	{ href: "/authors", label: "Authors", keywords: "guest author byline biography" },
	{ href: "/mailing-lists", label: "Mailing lists", keywords: "reader email preference membership" },
	{ href: "/perks", label: "Subscriber perks", keywords: "paid benefits downloads codes" },
	{ href: "/gift-links", label: "Gift links", keywords: "share paid issue free read link" },
	{ href: "/website", label: "Website", keywords: "theme brand pages navigation seo" },
	{ href: "/products", label: "Products", keywords: "shop sell digital paid" },
	{ href: "/link-page", label: "Link page", keywords: "link in bio links profile instagram" },
	{ href: "/newsletters", label: "Settings", keywords: "newsletter sender domain website" },
	{ href: "/orders", label: "Orders", keywords: "sales buyers" },
	{ href: "/payments", label: "Payments", keywords: "stripe payouts" },
	{ href: "/media", label: "Media", keywords: "images files uploads folders library" },
	{ href: "/fleet", label: "Brand fleet", keywords: "brands newsletters health sending domains" },
	{ href: "/domains", label: "Domains", keywords: "dns sending custom" },
	{ href: "/api-keys", label: "API keys", keywords: "token mcp developer" },
	{ href: "/approvals", label: "Approvals", keywords: "agent ai review approve reject send safety" },
	{ href: "/agent-activity", label: "Agent activity", keywords: "agent ai log audit keys mcp" },
	{ href: "/webhooks", label: "Webhooks", keywords: "zapier make events" },
	{ href: "/account", label: "Account", keywords: "profile export delete passkey sign out" },
];

// FlockStack Cloud only (hasBilling), and the admins'.
// Only where audio versions are on and the plan has them (components/LayoutDashboard.jsx).
export const AUDIO_PAGE = { href: "/audio", label: "Audio", keywords: "voice podcast listen text to speech" };
export const BILLING_PAGE = { href: "/billing", label: "Billing", keywords: "plan subscription invoice upgrade" };
export const ADMIN_PAGE = { href: "/admin", label: "Admin", keywords: "accounts" };

export const MIN_SEARCH_LENGTH = 2;

// How well a query matches a label and its keywords: higher is better, 0 no match. Every word of the query has to match.
export function scoreMatch(query, { label, keywords = "" }) {
	const words = String(query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
	if (words.length === 0) return 1;
	const name = label.toLowerCase();
	const extra = keywords.toLowerCase();
	let total = 0;
	for (const word of words) {
		let score = 0;
		if (name === word) score = 100;
		else if (name.startsWith(word)) score = 80;
		else if (name.split(/\s+/).some((part) => part.startsWith(word))) score = 60;
		else if (name.includes(word)) score = 40;
		else if (extra.split(/\s+/).some((part) => part.startsWith(word))) score = 20;
		else return 0;
		total += score;
	}
	return total;
}

export function filterItems(query, items) {
	return items
		.map((item, index) => ({ item, index, score: scoreMatch(query, item) }))
		.filter(({ score }) => score > 0)
		.toSorted((a, b) => b.score - a.score || a.index - b.index)
		.map(({ item }) => item);
}

// What the palette lists for a query, in sections: the pages and the new issue action that match, then the issues and
// contacts the server found. Without a query: the new issue action and the pages.
export function buildSections(query, { pages, canCreate, found = { campaigns: [], contacts: [] } }) {
	const actions = canCreate ? [{ id: "new-issue", kind: "new-issue", label: "New issue", keywords: "create write draft campaign compose" }] : [];
	const sections = [
		{ title: "Actions", items: filterItems(query, actions) },
		{ title: "Pages", items: filterItems(query, pages.map((page) => ({ ...page, id: page.href, kind: "page" }))) },
		{
			title: "Issues",
			items: found.campaigns.map((campaign) => ({ id: campaign.id, kind: "issue", label: campaign.subject || "Untitled", href: `/campaigns/${campaign.id}`, detail: campaign.status })),
		},
		{
			title: "Contacts",
			items: found.contacts.map((contact) => ({ id: contact.id, kind: "contact", label: contact.email, href: `/contacts?q=${encodeURIComponent(contact.email)}`, detail: contact.status })),
		},
	];
	return sections.filter(({ items }) => items.length > 0);
}

// Cmd+K on a Mac, Ctrl+K elsewhere; a key the editor already used (a link on selected text) is left alone.
export function isPaletteShortcut(event) {
	return Boolean((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key?.toLowerCase() === "k" && !event.defaultPrevented);
}

// The item after or before the current one, wrapping round.
export function moveIndex(index, count, direction) {
	return count === 0 ? 0 : (index + direction + count) % count;
}
