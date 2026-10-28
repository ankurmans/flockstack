import { getLinkBaseUrl, getNewsletterHost } from "./archive-hosts.js";
import { isSignedWithAppKey, signWithAppKey } from "./app-keys.js";
import { LIGHT_PAGE, getBrand, getReadableAccent } from "./brand.js";
import { isIssueCardOn } from "./issue-card-rules.js";
import { CARD_SIZE, getCardHash } from "./share-card.js";

// What an email shows of the visuals (docs/VISUALS-DESIGN.md): the issue's card at the top and the section icons beside its
// headings, both images on the newsletter's link host like every link in an email (never a mount, never another host).
const CARD_LINK_INFO = "flockstack issue card";
const CARD_SIGNATURE_LENGTH = 22;
export const EMAIL_CARD_WIDTH = 600;
export const EMAIL_ICON_SIZE = 24;

export { isBriefingCampaign, isIssueCardOn } from "./issue-card-rules.js";

// Where the newsletter's archive routes answer on its link host: /og and /icon/<key>.png there map onto app/archive/[slug]
// (proxy.js); without a host they are under APP_URL/archive/<slug>.
export function getArchiveAssetBase(newsletter, options) {
	return getNewsletterHost(newsletter, options?.sharedDomain) ? getLinkBaseUrl(newsletter, options) : `${getLinkBaseUrl(newsletter, options)}/archive/${newsletter.slug}`;
}

function cardValue(newsletterId, campaignId) {
	return `${newsletterId}:${campaignId}`;
}

// An email's card is asked for by its campaign, signed, so a draft's test email and an email only issue have one too.
export function isCardSignature({ newsletterId, campaignId }, signature) {
	return isSignedWithAppKey(CARD_LINK_INFO, cardValue(newsletterId, campaignId), signature, CARD_SIGNATURE_LENGTH);
}

// { url, alt, width, height } of the issue's card for its email, or null when the card is off.
export function getEmailCard({ newsletter, campaign }, options) {
	if (!newsletter?.slug || !campaign?._id || !isIssueCardOn(newsletter, campaign)) return null;
	const hash = getCardHash(newsletter, campaign, options);
	const signature = signWithAppKey(CARD_LINK_INFO, cardValue(newsletter._id, campaign._id), CARD_SIGNATURE_LENGTH);
	const url = `${getArchiveAssetBase(newsletter, options)}/og?c=${campaign._id}&s=${signature}&v=${hash}`;
	const height = Math.round((EMAIL_CARD_WIDTH * CARD_SIZE.height) / CARD_SIZE.width);
	return { url, alt: campaign.subject || newsletter.name, width: EMAIL_CARD_WIDTH, height };
}

// The color section icons are drawn in: the accent, or the shade of it that reads on the email's white page.
export function getIconColor(newsletter) {
	return getReadableAccent(getBrand(newsletter).accent, LIGHT_PAGE).slice(1);
}

// A section icon's address for an email: the color is in it, so a new accent is a new address.
export function getEmailIconUrl(newsletter, key, options) {
	// v: the drawing's version (the icon route's ICON_VERSION), so a client that cached the old drawing asks again.
	return `${getArchiveAssetBase(newsletter, options)}/icon/${key}.png?c=${getIconColor(newsletter)}&v=2`;
}
