import { getIssueContentHtml } from "./archive-content.js";
import { getArchiveUrls } from "./archive-hosts.js";
import { PUBLISHED_STATUSES } from "./archive-issues.js";
import { htmlToMarkdown } from "./html-to-markdown.js";
import { renderEmail } from "./render-email.js";
import { slugify } from "./slug.js";

// What goes into the ZIP of an account export, as text: the layout of its folders, each campaign as Markdown and HTML
// with its frontmatter, and the manifest. docs/export says the same for people.
export const EXPORT_FORMAT_VERSION = 1;
// How long an export's download links work, and its files are kept (lib/retention.js, which the legal pages read).
export { EXPORT_LINK_DAYS } from "./retention.js";
const IMAGE_URL_PATTERN = /https?:\/\/[^\s"'<>()\]\\]+/g;
const TRAILING_PUNCTUATION = /[.,;:!?]+$/;
// The files of a campaign sit two folders down: campaigns/<newsletter>/<file>.
const IMAGE_FOLDER_FROM_CAMPAIGN = "../../images";

function yamlValue(value) {
	if (value instanceof Date) return value.toISOString();
	return JSON.stringify(String(value));
}

// Frontmatter in YAML, as static site generators read it: strings quoted, dates as ISO 8601, empty values left out.
export function toFrontmatter(fields) {
	const lines = Object.entries(fields)
		.filter(([, value]) => value !== undefined && value !== null && value !== "")
		.map(([key, value]) => `${key}: ${yamlValue(value)}`);
	return `---\n${lines.join("\n")}\n---\n`;
}

export function getCampaignDate(campaign) {
	return campaign.sentAt || campaign.startedAt || campaign.scheduledAt || campaign.createdAt || null;
}

// campaigns/<newsletter>/2026-10-04-how-to-price-a-side-project. An issue's archive slug is unique already; a draft
// without one gets the end of its ID so two drafts with the same subject don't share a file.
export function getCampaignBasePath({ campaign, newsletterSlug }) {
	const date = getCampaignDate(campaign);
	const day = date ? new Date(date).toISOString().slice(0, 10) : "undated";
	const name = campaign.archiveSlug || `${slugify(campaign.subject, 80) || "untitled"}-${String(campaign._id).slice(-6)}`;
	return `campaigns/${newsletterSlug}/${day}-${name}`;
}

// Image addresses a campaign's text mentions. Which of them are the account's own uploads is for the caller to say.
export function findImageUrls(campaign) {
	const found = new Set();
	for (const text of [campaign.html, campaign.markdown, campaign.thumbnailUrl]) {
		for (const [url] of String(text ?? "").matchAll(IMAGE_URL_PATTERN)) {
			found.add(url);
			found.add(url.replace(TRAILING_PUNCTUATION, ""));
		}
	}
	return [...found];
}

// images: address to the file's path in the ZIP. Replaces the longest addresses first, so one that is the start of another
// doesn't cut it short.
export function pointToLocalImages(text, images) {
	let result = text;
	for (const [url, path] of [...images].sort((a, b) => b[0].length - a[0].length)) {
		result = result.replaceAll(url, `${IMAGE_FOLDER_FROM_CAMPAIGN}/${path.slice("images/".length)}`);
	}
	return result;
}

// The campaign's two files: Markdown (what it was written in, or its HTML turned into Markdown) and a standalone HTML page
// as the archive shows it. images: the uploads it uses, by address.
export function buildCampaignFiles({ campaign, newsletter, images = new Map() }) {
	const basePath = getCampaignBasePath({ campaign, newsletterSlug: newsletter.slug });
	const date = getCampaignDate(campaign);
	const isPublished = PUBLISHED_STATUSES.includes(campaign.status);
	const archiveUrl = newsletter.archiveEnabled && campaign.archiveSlug && isPublished ? getArchiveUrls(newsletter).absolutePost(campaign.archiveSlug) : null;
	const frontmatter = toFrontmatter({
		title: campaign.subject || "Untitled",
		date: date ? new Date(date) : null,
		newsletter: newsletter.slug,
		status: campaign.status,
		archive_url: archiveUrl,
		preview_text: campaign.previewText,
		slug: campaign.archiveSlug,
		format: campaign.format,
		id: String(campaign._id),
	});

	const markdownBody = campaign.format === "markdown" ? campaign.markdown : htmlToMarkdown(getIssueContentHtml(campaign, { referralLink: null }));
	const html = renderEmail({
		format: campaign.format,
		markdown: campaign.markdown,
		html: campaign.html,
		subject: campaign.subject,
		previewText: campaign.previewText,
		newsletter,
		isWebVersion: true,
	}).html;
	return {
		markdown: { path: `${basePath}.md`, text: `${frontmatter}\n${pointToLocalImages(markdownBody ?? "", images).trimEnd()}\n` },
		html: { path: `${basePath}.html`, text: `${frontmatter}${pointToLocalImages(html, images)}` },
		meta: {
			id: String(campaign._id),
			newsletter: newsletter.slug,
			title: campaign.subject || "",
			date: date ? new Date(date).toISOString() : null,
			status: campaign.status,
			archiveUrl,
			markdown: `${basePath}.md`,
			html: `${basePath}.html`,
		},
	};
}

export function getImagePath(upload) {
	const name = String(upload.pathname || upload.url).split("/").pop().replace(/[^A-Za-z0-9._-]/g, "-") || "image";
	return `images/${name}`;
}

// Where a file sorts in the ZIP: the manifest and the README first, then everything else by path.
export function getFileOrder(path) {
	return `${path.includes("/") ? "1" : "0"}${path}`;
}

export function toNewsletterSettings(newsletter) {
	const urls = getArchiveUrls(newsletter);
	return {
		id: String(newsletter._id),
		slug: newsletter.slug,
		name: newsletter.name,
		description: newsletter.description ?? "",
		fromName: newsletter.fromName ?? "",
		fromEmail: newsletter.fromEmail,
		replyTo: newsletter.replyTo ?? "",
		postalAddress: newsletter.postalAddress ?? "",
		imageUrl: newsletter.imageUrl ?? "",
		author: { bio: newsletter.author?.bio ?? "", imageUrl: newsletter.author?.imageUrl ?? "" },
		socialLinks: newsletter.socialLinks ?? [],
		archiveEnabled: Boolean(newsletter.archiveEnabled),
		archiveUrl: newsletter.archiveEnabled ? urls.siteIndex : null,
		feedUrl: newsletter.archiveEnabled ? urls.feed : null,
		requireConfirmation: Boolean(newsletter.requireConfirmation),
		welcome: {
			enabled: Boolean(newsletter.welcome?.enabled),
			subject: newsletter.welcome?.subject ?? "",
			previewText: newsletter.welcome?.previewText ?? "",
			markdown: newsletter.welcome?.markdown ?? "",
		},
		confirmation: {
			subject: newsletter.confirmation?.subject ?? "",
			previewText: newsletter.confirmation?.previewText ?? "",
			markdown: newsletter.confirmation?.markdown ?? "",
		},
		comments: newsletter.comments?.enabled || newsletter.comments?.who || newsletter.comments?.moderation
			? { enabled: Boolean(newsletter.comments.enabled), who: newsletter.comments.who ?? "everyone", moderation: newsletter.comments.moderation ?? "none" }
			: null,
		cleanup: { enabled: Boolean(newsletter.cleanup?.enabled), issues: newsletter.cleanup?.issues ?? null, days: newsletter.cleanup?.days ?? null },
		referral: newsletter.referral
			? { enabled: Boolean(newsletter.referral.enabled), rewards: (newsletter.referral.rewards ?? []).map(({ referrals, title, url, text }) => ({ referrals, title, url: url ?? "", text: text ?? "" })) }
			: null,
		createdAt: newsletter.createdAt ? new Date(newsletter.createdAt).toISOString() : null,
	};
}

// files: the ExportFile documents of everything but the manifest and the README.
export function buildManifest({ exportedAt, accountId, newsletters, files, counts }) {
	const campaignFiles = files.filter(({ meta }) => meta?.markdown);
	return {
		format: "flockstack-export",
		version: EXPORT_FORMAT_VERSION,
		exportedAt: exportedAt.toISOString(),
		accountId: String(accountId),
		counts,
		newsletters: newsletters.map((settings) => ({
			...settings,
			contactsFile: files.find(({ path }) => path === `contacts/${settings.slug}.csv`)?.path ?? null,
			contactCount: files.find(({ path }) => path === `contacts/${settings.slug}.csv`)?.meta?.rows ?? 0,
			commentsFile: files.find(({ path }) => path === `comments/${settings.slug}.csv`)?.path ?? null,
			commentCount: files.find(({ path }) => path === `comments/${settings.slug}.csv`)?.meta?.rows ?? 0,
		})),
		campaigns: campaignFiles.map(({ meta }) => meta),
		images: files
			.filter(({ kind }) => kind === "image")
			.map(({ path, state, size, crc, meta, error }) => ({ path, url: meta?.url ?? null, contentType: meta?.contentType ?? null, bytes: size, crc32: crc.toString(16).padStart(8, "0"), status: state, ...(error && { error }) })),
		files: files.filter(({ kind }) => kind !== "image").map(({ path, size, crc }) => ({ path, bytes: size, crc32: crc.toString(16).padStart(8, "0") })),
	};
}

export function buildReadme({ exportedAt, volumes }) {
	return `FlockStack export, ${exportedAt.toISOString().slice(0, 10)}
${volumes > 1 ? `\nThis is one of ${volumes} ZIP files. Together they hold everything; manifest.json is in the first.\n` : ""}
manifest.json   Everything in this export, with each newsletter's settings. Machine-readable.
contacts/       One CSV per newsletter: email, status, source, signup and confirmation dates,
                engagement (emails received, opens, clicks, last open and click), tags, referrals
                and a column for each custom field.
                The import accepts these files as they are.
suppressions.csv  Addresses that bounced, complained or were blocked. Keep them off any list you move to.
comments/       One CSV per newsletter that has comments: the comment, the issue it is on, who wrote it, its state and the
                reason it was held, hidden or removed.
content-calendar/  One CSV per newsletter that has planned content: each issue or post, its copy, planned day, state and notes.
campaigns/      Every issue and draft as a Markdown and an HTML file, with frontmatter
                (title, date, newsletter, status, archive_url). Pictures point to images/.
images/         The pictures your issues use, from your FlockStack library.

Your data is yours. Nothing here is encrypted or locked to FlockStack.
`;
}
