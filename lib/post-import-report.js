import { formatNumber } from "./format.js";

// An export is read whole in a Worker's memory, so it stays well under the 128 MB a Worker has.
export const MAX_IMPORT_FILE_BYTES = 40 * 1024 * 1024;
// Pictures one import may copy, whatever the plan.
export const MAX_IMAGES_PER_IMPORT = 10_000;

// What the dashboard, the email and the docs call each platform a post import reads.
export const SOURCE_NAMES = { substack: "Substack", beehiiv: "beehiiv", wordpress: "WordPress", ghost: "Ghost", mailchimp: "Mailchimp" };

// An import's report in a sentence: "12 posts imported, 3 already there, 40 pictures copied".
export function describeImportCounts(counts) {
	const parts = [`${formatNumber(counts.imported)} ${counts.imported === 1 ? "post" : "posts"} imported`];
	if (counts.existing) parts.push(`${formatNumber(counts.existing)} already there`);
	if (counts.overLimit) parts.push(`${formatNumber(counts.overLimit)} past your plan's limit`);
	if (counts.failed) parts.push(`${formatNumber(counts.failed)} that couldn't be imported`);
	if (counts.images) parts.push(`${formatNumber(counts.images)} ${counts.images === 1 ? "picture" : "pictures"} copied`);
	if (counts.imageFailures) parts.push(`${formatNumber(counts.imageFailures)} ${counts.imageFailures === 1 ? "picture" : "pictures"} left at the old address`);
	if (counts.redirects) parts.push(`${formatNumber(counts.redirects)} ${counts.redirects === 1 ? "redirect" : "redirects"} added`);
	return parts.join(", ");
}
