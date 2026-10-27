// Share buttons in an issue's email header: plain links readers click to share the issue's web page. Each network gets the
// page's address and the subject through its own sharing address; nothing is loaded from the network and nothing is
// stored. They need the issue's page, so an issue without a public page has none.
const NETWORKS = [
	{ id: "x", label: "X", host: "twitter.com", build: ({ url, title }) => `https://twitter.com/intent/tweet?url=${encodeURIComponent(url)}&text=${encodeURIComponent(title)}` },
	{ id: "linkedin", label: "LinkedIn", host: "www.linkedin.com", build: ({ url }) => `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(url)}` },
	{ id: "facebook", label: "Facebook", host: "www.facebook.com", build: ({ url }) => `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}` },
	{ id: "email", label: "Email", host: null, build: ({ url, title }) => `mailto:?subject=${encodeURIComponent(title)}&body=${encodeURIComponent(url)}` },
];

// The hosts the links lead to, which UTM tagging leaves alone (lib/link-utm.js): the tag belongs on the shared page, not on a share form.
export const SHARE_HOSTS = NETWORKS.map(({ host }) => host).filter(Boolean);

// The issue's own word over the newsletter's: shareButtons is true, false, or unset to follow the newsletter. Off by default.
export function areShareButtonsOn(newsletter, campaign) {
	if (typeof campaign?.shareButtons === "boolean") return campaign.shareButtons;
	return Boolean(newsletter?.shareButtons);
}

// [{ id, label, href }] for the page at url, or none without one.
export function getShareLinks({ url, title = "" }) {
	if (!url) return [];
	const shared = { url, title: String(title ?? "").slice(0, 200) };
	return NETWORKS.map(({ id, label, build }) => ({ id, label, href: build(shared) }));
}
