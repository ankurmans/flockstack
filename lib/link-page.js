// A newsletter's link-in-bio page: a hosted page of the links its writer lists, at /links on the newsletter's host.
export const LINK_PAGE_LIMITS = { links: 20, label: 80, url: 2000, title: 80, bio: 300 };

const ALLOWED_PROTOCOLS = new Set(["https:", "http:", "mailto:"]);

// The link as stored: https:// when written without a scheme ("example.com/shop"), and only web and email addresses. null when it
// isn't one a page may link to (javascript:, data:, file:, an address with spaces).
export function normalizeLinkUrl(value) {
	const text = String(value ?? "").trim();
	if (!text || text.length > LINK_PAGE_LIMITS.url || /\s/.test(text)) return null;
	const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : /^[^\s@/]+@[^\s@/]+\.[^\s@/]+$/.test(text) ? `mailto:${text}` : `https://${text}`;
	try {
		const url = new URL(withScheme);
		if (!ALLOWED_PROTOCOLS.has(url.protocol)) return null;
		if (url.protocol !== "mailto:" && (!url.hostname.includes(".") || url.username || url.password)) return null;
		return url.protocol === "mailto:" ? withScheme : url.toString();
	} catch {
		return null;
	}
}

// { links } with each one cleaned, or { error } naming the first that isn't valid.
export function readLinks(input) {
	if (!Array.isArray(input)) return { error: "links: send a list" };
	if (input.length > LINK_PAGE_LIMITS.links) return { error: `links: ${LINK_PAGE_LIMITS.links} at most` };
	const links = [];
	for (const [index, item] of input.entries()) {
		const label = String(item?.label ?? "").trim().replace(/\s+/g, " ");
		const url = normalizeLinkUrl(item?.url);
		if (!label || label.length > LINK_PAGE_LIMITS.label) return { error: `links.${index}.label: 1 to ${LINK_PAGE_LIMITS.label} characters` };
		if (!url) return { error: `links.${index}.url: use an https:// address, or an email address` };
		links.push({ label, url });
	}
	return { links };
}

// The page as the dashboard and the website show it. A stored link that isn't one a page may link to is left out, whatever
// wrote it.
export function toLinkPage(newsletter) {
	const page = newsletter.linkPage ?? {};
	return {
		enabled: Boolean(page.enabled),
		title: page.title ?? "",
		bio: page.bio ?? "",
		links: (page.links ?? []).filter(({ label, url }) => label && normalizeLinkUrl(url) === url).map(({ label, url }) => ({ label, url })),
	};
}

// A link that leaves the page: a new tab, with nothing passed on about where the reader came from.
export function isExternal(url) {
	return /^https?:/i.test(url);
}
