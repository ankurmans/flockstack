import { hostOf } from "./urls.js";

// What kind of source a page is (docs/BRIEFINGS-DESIGN.md, Cluster), by its address where that is plain: wire services carry
// press releases, EDGAR carries filings, government and regulators' sites are regulators, a company's newsroom or investor site
// is the company speaking, discussion sites are community. Anything else is left to the extract model (null here).
const WIRES = ["prnewswire.com", "globenewswire.com", "businesswire.com", "accesswire.com", "newswire.ca", "einpresswire.com", "prweb.com", "newsfilecorp.com", "presseportal.de"];
const FILINGS = ["sec.gov", "sedarplus.ca", "find-and-update.company-information.service.gov.uk", "companieshouse.gov.uk"];
const REGULATORS = ["europa.eu", "fca.org.uk", "ofcom.org.uk", "ofgem.gov.uk", "esma.europa.eu", "bankofengland.co.uk", "ecb.europa.eu", "bis.org", "iosco.org", "cnil.fr", "bafin.de", "asic.gov.au"];
const COMMUNITY = ["news.ycombinator.com", "reddit.com", "bsky.app", "x.com", "twitter.com", "mastodon.social", "lobste.rs", "threads.net", "linkedin.com", "medium.com", "substack.com"];
const COMPANY_HOST = /^(?:newsroom|investors?|ir|press)\./;
const COMPANY_PATH = /\/(?:newsroom|press-releases?|press|investor-relations|investors|media-centre|media-center)(?:\/|$)/i;

function within(host, list) {
	return list.some((entry) => host === entry || host.endsWith(`.${entry}`));
}

// One of SOURCE_KINDS, or null when the address doesn't say.
export function labelSource(url) {
	const host = hostOf(url);
	if (!host) return "other";
	let pathname = "";
	try {
		pathname = new URL(url).pathname;
	} catch {
		return "other";
	}
	if (within(host, WIRES)) return "press_release";
	if (within(host, FILINGS) || /\/cgi-bin\/browse-edgar|\/Archives\/edgar\//i.test(pathname)) return "filing";
	if (within(host, REGULATORS) || /(?:^|\.)gov(?:\.[a-z]{2})?$|\.gouv\.fr$|\.gc\.ca$|\.gob\.[a-z]{2}$/.test(host)) return "regulator";
	if (within(host, COMMUNITY)) return "community";
	if (COMPANY_HOST.test(host) || COMPANY_PATH.test(pathname)) return "company";
	return null;
}

// Independent reporting first (labelled reporting, or not yet labelled and not the company's own), then the original document.
const PREFERENCE = { reporting: 0, null: 1, filing: 2, regulator: 3, press_release: 4, company: 5, other: 6, community: 7 };

// Within a kind, a trusted outlet first, then the newest, then the source more indexes found.
export function rankSources(sources, { trustedOutlets = [] } = {}) {
	const trusted = (source) => (trustedOutlets.some((host) => source.host === host || source.host?.endsWith(`.${host}`)) ? 0 : 1);
	return [...sources].sort(
		(a, b) =>
			(PREFERENCE[a.sourceKind ?? "null"] ?? 6) - (PREFERENCE[b.sourceKind ?? "null"] ?? 6) ||
			trusted(a) - trusted(b) ||
			String(b.publishedAt ?? "").localeCompare(String(a.publishedAt ?? "")) ||
			(b.foundBy?.length ?? 0) - (a.foundBy?.length ?? 0)
	);
}

const ORIGINAL_DOCUMENTS = new Set(["press_release", "company", "filing", "regulator"]);

// "Announced by Acme" (or "Press release" when the company isn't known), "Filing" or "Regulator's notice" for a story whose every
// source is the original document rather than reporting about it; null when any independent source carried it.
export function originLabel(sources, company) {
	const kinds = sources.map(({ sourceKind }) => sourceKind);
	if (!kinds.length || !kinds.every((kind) => ORIGINAL_DOCUMENTS.has(kind))) return null;
	if (kinds.includes("press_release") || kinds.includes("company")) return company ? `Announced by ${company}` : "Press release";
	return kinds.includes("filing") ? "Filing" : "Regulator's notice";
}
