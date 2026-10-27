import { LIMITS } from "./config.js";
import { formatCount, formatNumber } from "./format.js";
import { findMergeTags } from "./merge-tags.js";
import { UNSUBSCRIBE_PLACEHOLDER, hasContent } from "./render-email.js";

// The ready-to-send check (the review step's list, and check_campaign for the API and MCP): each thing a writer would want
// to know before sending is one item with a status and one plain sentence. Plain functions of what was gathered
// (lib/ready-check-data.js gathers it), so the dashboard and the actions say the same words.
//
// status: pass, warning (worth a look, never stops a send), blocker (the send is refused until it's fixed) or info.
export const SUBJECT_WARN_LENGTH = 60;
export const IMAGE_WARN_BYTES = 1_000_000;
export const MAX_CHECKED_LINKS = 20;
const MAX_LISTED = 3;

function readAttribute(tag, name) {
	const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i").exec(tag);
	if (!match) return null;
	return (match[1] ?? match[2]).replaceAll("&amp;", "&").replaceAll("&quot;", '"').replaceAll("&#39;", "'").trim();
}

// The addresses the issue links to that a person could open: http and https, once each, in order. Mailto and tel links,
// anchors, merge tags and the unsubscribe and poll placeholders have nothing to load.
export function findLinks(html) {
	const urls = [];
	for (const [tag] of String(html ?? "").matchAll(/<a\b[^>]*>/gi)) {
		const href = readAttribute(tag, "href");
		if (!href || !/^https?:\/\//i.test(href) || href.includes("{{") || /%7[Bb]%7[Bb]/.test(href)) continue;
		if (!urls.includes(href)) urls.push(href);
	}
	return urls;
}

export function findImages(html) {
	return [...String(html ?? "").matchAll(/<img\b[^>]*>/gi)]
		.map(([tag]) => ({ src: readAttribute(tag, "src"), alt: readAttribute(tag, "alt") }))
		.filter(({ src }) => src && !src.startsWith("blob:") && !src.startsWith("data:"));
}

// Patterns that read as pushy in a subject line. A few honest ones, never a score: warnings only.
export function getSpamSignals(subject) {
	const text = String(subject ?? "").trim();
	const signals = [];
	const letters = text.replace(/[^A-Za-z]/g, "");
	if (letters.length >= 8 && letters === letters.toUpperCase()) signals.push("it is all capital letters");
	if ((text.match(/!/g) ?? []).length >= 3 || /!{2,}/.test(text)) signals.push("it has several exclamation marks");
	if (/\bfree\b[^a-z0-9]{0,3}!|\bfree\b.*!{2,}/i.test(text)) signals.push("it shouts \"free\"");
	if (/\${2,}|€{2,}|£{2,}/.test(text)) signals.push("it is full of money signs");
	return signals;
}

// A body's tags other than the ones the email fills in itself, once each, with the fallback each was written with.
export function findMergeUsage(...texts) {
	const usage = new Map();
	for (const text of texts) {
		for (const name of findMergeTags(text)) if (name !== "email" && !usage.has(name)) usage.set(name, "");
		for (const [, name, fallback] of String(text ?? "").matchAll(/\{\{([a-z][a-z0-9_]{0,29})\|([^{}|]{0,100})\}\}/g)) if (usage.has(name) && !usage.get(name)) usage.set(name, fallback.trim());
	}
	return usage;
}

function item(id, status, title, message, fix = null) {
	return { id, status, title, message, fix };
}

const FIXES = {
	subject: { label: "Edit subject", target: "subject" },
	previewText: { label: "Add preview text", target: "previewText" },
	body: { label: "Edit content", target: "body" },
	audience: { label: "Change who gets it", target: "send" },
	test: { label: "Send a test", target: "test" },
};

function pointer(kind, newsletterId) {
	if (FIXES[kind]) return FIXES[kind];
	if (kind === "postalAddress") return { label: "Add a postal address", target: "settings", path: "/newsletters#postal-address" };
	if (kind === "sender") return { label: "Open settings", target: "settings", path: `/newsletters/${newsletterId}` };
	return { label: "See plans", target: "billing", path: "/billing" };
}

function listUrls(urls) {
	const shown = urls.slice(0, MAX_LISTED).map((url) => url.replace(/^https?:\/\//, "").slice(0, 60));
	return urls.length > MAX_LISTED ? `${shown.join(", ")} and ${urls.length - MAX_LISTED} more` : shown.join(", ");
}

function formatSize(bytes) {
	return bytes >= 1_000_000 ? `${(bytes / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.ceil(bytes / 1000))} KB`;
}

function checkLinks(links) {
	if (!links || links.state === "none") return item("links", "pass", "Links", "There are no links to check.");
	if (links.state === "checking") return item("links", "info", "Links", `Checking ${formatCount(links.total, "link")}…`, null);
	if (links.state === "error") return item("links", "info", "Links", "The links couldn't be checked just now, so they weren't. Check again in a minute.");
	const more = links.total > links.checked ? ` The first ${links.checked} of ${links.total} were checked.` : "";
	if (links.broken.length === 0) {
		const unsure = links.unsure ?? 0;
		return item("links", "pass", "Links", `${links.checked === 1 ? "The link works" : `All ${links.checked} links work`}${unsure ? `, ${unsure} of them blocked the check but are probably fine` : ""}.${more}`);
	}
	const reasons = links.broken.map(({ url, reason }) => `${url.replace(/^https?:\/\//, "").slice(0, 60)} (${reason})`);
	const shown = reasons.slice(0, MAX_LISTED).join(", ") + (reasons.length > MAX_LISTED ? ` and ${reasons.length - MAX_LISTED} more` : "");
	return item("links", "warning", "Links", `${links.broken.length === 1 ? "A link doesn't" : `${links.broken.length} links don't`} load: ${shown}.${more}`, pointer("body"));
}

function checkImages(images, sizes) {
	if (images.length === 0) return [];
	const items = [];
	const missing = images.filter(({ alt }) => !alt?.trim());
	items.push(
		missing.length === 0
			? item("images-alt", "pass", "Image descriptions", images.length === 1 ? "The image has alt text." : `All ${images.length} images have alt text.`)
			: item("images-alt", "warning", "Image descriptions", `${missing.length === 1 ? "An image has" : `${missing.length} of ${images.length} images have`} no alt text, so readers who can't see ${missing.length === 1 ? "it" : "them"} get nothing.`, pointer("body"))
	);
	const known = images.map((image) => ({ ...image, bytes: sizes.get(image.src) })).filter(({ bytes }) => Number.isFinite(bytes));
	const huge = known.filter(({ bytes }) => bytes > IMAGE_WARN_BYTES);
	items.push(
		huge.length === 0
			? item("images-size", "pass", "Image sizes", known.length === 0 ? "The images come from other sites, so their sizes weren't checked." : `No image is over ${formatSize(IMAGE_WARN_BYTES)}.`)
			: item("images-size", "warning", "Image sizes", `${huge.length === 1 ? "An image is" : `${huge.length} images are`} over ${formatSize(IMAGE_WARN_BYTES)} (the biggest is ${formatSize(Math.max(...huge.map(({ bytes }) => bytes)))}), which is slow to load on a phone.`, pointer("body"))
	);
	return items;
}

function checkMergeTags(mergeTags) {
	if (!mergeTags || mergeTags.length === 0) return [];
	const unknown = mergeTags.filter(({ isField }) => !isField);
	const empty = mergeTags.filter(({ isField, missing }) => isField && missing > 0);
	if (unknown.length === 0 && empty.length === 0) return [item("merge-tags", "pass", "Merge tags", "Every merge tag has a value for everyone who gets this.")];
	const parts = [
		...unknown.map(({ name, fallback }) => `{{${name}}} isn't a field of this newsletter, so it prints ${fallback ? `"${fallback}"` : "nothing"}`),
		...empty.map(({ name, fallback, missing, total }) => `{{${name}}} is empty for ${formatNumber(missing)} of ${formatNumber(total)} contacts, who see ${fallback ? `"${fallback}"` : "nothing there (add a fallback like {{" + name + "|there}})"}`),
	];
	return [item("merge-tags", "warning", "Merge tags", `${parts.join("; ")}.`, pointer("body"))];
}

// The whole check. senderProblem and planProblem are the send's own refusals, in its own words.
export function buildReadyCheck({
	campaign,
	newsletter,
	rendered,
	senderProblem = null,
	isSendingEnabled = true,
	planProblem = null,
	audience = { count: 0, label: "Everyone", segmentName: null },
	emailsLeft = null,
	emails = null,
	isFreePlan = false,
	sentWith = false,
	images = [],
	imageSizes = new Map(),
	mergeTags = [],
	links = null,
	hasPaywallBreak = false,
	now = Date.now(),
}) {
	const subject = campaign.subject?.trim() ?? "";
	const isWebOnly = campaign.publishTo === "web";
	const items = [];

	if (campaign.kind === "note") items.push(item("subject", "info", "Short web post", "No title or email subject is needed. Its excerpt is used for search and sharing."));
	else if (!subject) items.push(item("subject", "blocker", "Subject", "Add a subject line.", pointer("subject")));
	else if (subject.length > SUBJECT_WARN_LENGTH) items.push(item("subject", "warning", "Subject", `Your subject is ${subject.length} characters, and inboxes cut off anything past about ${SUBJECT_WARN_LENGTH}.`, pointer("subject")));
	else items.push(item("subject", "pass", "Subject", `Your subject is ${subject.length} characters, short enough to show whole.`));

	if (!isWebOnly) {
		const preview = campaign.previewText?.trim() ?? "";
		items.push(
			preview
				? item("preview", "pass", "Preview text", "Inboxes show your preview text after the subject.")
				: item("preview", "warning", "Preview text", "Add preview text: inboxes show it after the subject, and without it they show the first words of the email.", pointer("previewText"))
		);
	}

	const body = campaign.format === "markdown" ? campaign.markdown : campaign.html;
	if (!hasContent(body)) items.push(item("content", "blocker", "Content", "The issue is empty: write something first.", pointer("body")));
	else items.push(item("content", "pass", "Content", "The issue has content."));

	const signals = getSpamSignals(subject);
	if (subject) {
		items.push(
			signals.length === 0
				? item("spam", "pass", "Subject tone", "Nothing in the subject reads as pushy.")
				: item("spam", "warning", "Subject tone", `Your subject may read as pushy because ${signals.join(" and ")}; inboxes are quicker to doubt that.`, pointer("subject"))
		);
	}

	if (!isWebOnly) {
		const hasUnsubscribe = rendered.html.includes(UNSUBSCRIBE_PLACEHOLDER);
		items.push(
			hasUnsubscribe
				? item("unsubscribe", "pass", "Unsubscribe link", "Every email ends with an unsubscribe link.")
				: item("unsubscribe", "blocker", "Unsubscribe link", `Your HTML has no unsubscribe link: add ${UNSUBSCRIBE_PLACEHOLDER} to it.`, pointer("body"))
		);
		items.push(
			rendered.bytes <= LIMITS.maxEmailBytes
				? item("size", "pass", "Email size", `The email is ${formatSize(rendered.bytes)}, under Gmail's 100 KB clipping.`)
				: item("size", "blocker", "Email size", `The email is ${formatSize(rendered.bytes)} and Gmail clips emails over 100 KB, hiding the end.`, pointer("body"))
		);
		items.push(
			newsletter.postalAddress?.trim()
				? item("address", "pass", "Postal address", "Your postal address is in the footer.")
				: item("address", "blocker", "Postal address", "Add a postal address to the newsletter: every email prints one in its footer.", pointer("postalAddress"))
		);
		items.push(
			senderProblem
				? item("sender", "blocker", "Sender address", senderProblem.endsWith(".") ? senderProblem : `${senderProblem}.`, pointer("sender", newsletter._id))
				: item("sender", "pass", "Sender address", `Emails go out from ${newsletter.fromEmail}, which is verified for sending.`)
		);
	} else {
		items.push(
			newsletter.archiveEnabled
				? item("website", "pass", "Website", "The newsletter's website is on, so the issue gets a page.")
				: item("website", "blocker", "Website", "Turn on the newsletter's website: a web only issue has nowhere else to go.", pointer("sender", newsletter._id))
		);
	}

	items.push(checkLinks(links));
	items.push(...checkImages(images, imageSizes));
	if (!isWebOnly) items.push(...checkMergeTags(mergeTags));

	if (!isWebOnly) {
		const where = audience.segmentName ? `the segment ${audience.segmentName}` : "everyone on the list";
		const who = campaign.audience && campaign.audience !== "all" ? `${audience.label.toLowerCase()} of ${where}` : where;
		if (audience.problem) items.push(item("audience", "blocker", "Audience", audience.problem.endsWith(".") ? audience.problem : `${audience.problem}.`, pointer("audience")));
		else if (audience.count === 0) items.push(item("audience", "blocker", "Audience", `Nobody would get this: ${who} has no active contacts.`, pointer("audience")));
		else items.push(item("audience", "info", "Audience", `It goes to ${formatCount(audience.count, "reader")}: ${who}.`));

		if (planProblem) items.push(item("plan", "blocker", "Plan limits", planProblem.endsWith(".") ? planProblem : `${planProblem}.`, pointer("plan")));
		else if (emailsLeft !== null && emails !== null) items.push(item("plan", "pass", "Plan limits", `This send uses ${formatCount(emails, "email")} and your plan has ${formatNumber(emailsLeft)} left this month.`));
		else items.push(item("plan", "pass", "Plan limits", "This send is within your plan's limits."));

		if (isFreePlan && sentWith) items.push(item("free-footer", "info", "Free plan footer", "On the Free plan every email ends with a \"Sent with FlockStack\" link; paid plans leave it out."));
		if (hasPaywallBreak && campaign.audience !== "paid") {
			items.push(
				item(
					"paywall",
					"info",
					"Paywall break",
					campaign.audience === "free"
						? "This issue goes to free readers only, so nobody gets the part below the paywall break: they see an upgrade card there."
						: "Free readers see the issue up to the paywall break and an upgrade card; paid readers get all of it."
				)
			);
		}
		items.push(
			campaign.testSentAt
				? item("test", "pass", "Test email", "You sent yourself a test of this issue.")
				: item("test", "warning", "Test email", "You haven't sent yourself a test: it shows the email as readers will see it.", pointer("test"))
		);
	}

	if (!isSendingEnabled) items.push(item("sending", "blocker", "Sending", "Sending is turned off on this server."));

	const blockers = items.filter(({ status }) => status === "blocker");
	const warnings = items.filter(({ status }) => status === "warning");
	return {
		items,
		blockers: blockers.length,
		warnings: warnings.length,
		canSend: blockers.length === 0,
		isChecking: links?.state === "checking",
		checkedAt: new Date(now).toISOString(),
	};
}
