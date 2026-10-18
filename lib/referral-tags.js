// The merge tags an issue can carry to share the program: each subscriber's own link and count. Markdown encodes the braces
// of a link (%7B%7B), so both spellings count.
export const REFERRAL_LINK_TAG = "{{referral_link}}";
export const REFERRAL_COUNT_TAG = "{{referral_count}}";
const LINK_PATTERN = /\{\{\s*referral_link\s*\}\}|%7B%7B\s*referral_link\s*%7D%7D/gi;
const COUNT_PATTERN = /\{\{\s*referral_count\s*\}\}|%7B%7B\s*referral_count\s*%7D%7D/gi;
const LINK_ONLY_PATTERN = /^(?:\{\{\s*referral_link\s*\}\}|%7B%7B\s*referral_link\s*%7D%7D)$/i;

// A link's address may be the merge tag, which the email fills in for each subscriber.
export function isReferralLinkTag(value) {
	return LINK_ONLY_PATTERN.test(String(value ?? "").trim());
}

export function hasReferralTags(text) {
	return /\{\{\s*referral_(?:link|count)\s*\}\}|%7B%7B\s*referral_(?:link|count)\s*%7D%7D/i.test(String(text ?? ""));
}

// link: null leaves the tag as it is. count: likewise.
export function fillReferralTags(text, { link = null, count = null } = {}) {
	let result = String(text ?? "");
	if (link !== null) result = result.replace(LINK_PATTERN, () => link);
	if (count !== null) result = result.replace(COUNT_PATTERN, () => String(count));
	return result;
}

// What the settings page offers to paste into an issue that is written in HTML or Markdown.
export const SHARE_BLOCK_HTML = `<div style="margin:24px 0;padding:16px 20px;border-radius:8px;background:#f4f4f5;">
<p style="margin:0 0 8px;"><strong>Share this newsletter, get rewards.</strong> You've referred ${REFERRAL_COUNT_TAG} so far.</p>
<p style="margin:0;">Your link: <a href="${REFERRAL_LINK_TAG}">${REFERRAL_LINK_TAG}</a></p>
</div>`;

export const SHARE_BLOCK_MARKDOWN = `**Share this newsletter, get rewards.** You've referred ${REFERRAL_COUNT_TAG} so far.

Your link: <a href="${REFERRAL_LINK_TAG}">${REFERRAL_LINK_TAG}</a>`;
