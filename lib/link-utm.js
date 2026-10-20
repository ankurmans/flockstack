import { cleanValue } from "./attribution.js";
import { slugify } from "./slug.js";

// A newsletter can tag the links its issues point to, so the sites they lead to see where the visit came from. It runs
// before the links are tracked (lib/tracking.js), so the click redirect lands on the tagged address.
const LINK_PATTERN = /(<a\b[^>]*?\shref\s*=\s*)(["'])(https?:\/\/[^"'\s]+)\2/gi;

// utm_source is the newsletter, utm_medium email, utm_campaign the issue's slug.
export function getLinkUtm({ newsletterName, campaignSlug }) {
	return {
		utm_source: cleanValue(newsletterName) ?? "newsletter",
		utm_medium: "email",
		utm_campaign: cleanValue(campaignSlug) ?? "issue",
	};
}

export function getCampaignUtmSlug(campaign) {
	return campaign?.archiveSlug || campaign?.resend?.slug || slugify(campaign?.subject, 60);
}

// ownHosts: FlockStack's own links (the newsletter's pages, the unsubscribe and preference links) stay as they are. A link
// that already has any utm_ parameter is the writer's own tag and stays too.
export function addUtmToLinks(html, utm, ownHosts = []) {
	const own = new Set(ownHosts.filter(Boolean).map((host) => String(host).toLowerCase()));
	return html.replace(LINK_PATTERN, (match, start, quote, href) => {
		const raw = href.replace(/&amp;|&#0*38;|&#x0*26;/gi, "&");
		let url;
		try {
			url = new URL(raw);
		} catch {
			return match;
		}
		if (own.has(url.host.toLowerCase())) return match;
		if ([...url.searchParams.keys()].some((name) => name.toLowerCase().startsWith("utm_"))) return match;
		for (const [name, value] of Object.entries(utm)) url.searchParams.set(name, value);
		return `${start}${quote}${url.toString().replaceAll("&", "&amp;")}${quote}`;
	});
}
