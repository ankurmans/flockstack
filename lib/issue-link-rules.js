import { findElements, readAttribute } from "./editor-blocks.js";
export const MAX_INTERNAL_LINKS = 100;
export function readIssueLinkRefs(html) {
	const links = [];
	for (const element of findElements(String(html ?? ""), (_tag, name) => name === "a")) {
		const id = readAttribute(element.tag, "data-issue-link"); const href = readAttribute(element.tag, "href");
		if (!/^[a-f0-9]{24}$/i.test(id ?? "") || !href || href.length > 2048 || links.some((link) => link.id === id.toLowerCase())) continue;
		links.push({ id: id.toLowerCase(), href });
		if (links.length === MAX_INTERNAL_LINKS) break;
	}
	return links;
}
export function sameIssueUrl(href, expected) {
	if (!expected) return false;
	try { const target = new URL(expected); const link = new URL(href, target); return target.origin === link.origin && target.pathname === link.pathname && !link.username && !link.password; } catch { return false; }
}
