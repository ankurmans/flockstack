import "server-only";
import * as z from "zod";
import { scoped } from "@/lib/account-scope";
import { areWelcomeEmailsPaused } from "@/lib/account-state";
import { defineAction } from "@/lib/actions/define-action";
import { actionError } from "@/lib/actions/errors";
import { assertSendingEnabled, dateOutput, findNewsletter, findTestRecipient, toIso } from "@/lib/actions/shared";
import { revalidateArchive } from "@/lib/archive-data";
import { FONT_PAIR_IDS, THEME_IDS, getBrand } from "@/lib/brand";
import { getArchiveUrls } from "@/lib/archive-hosts";
import { cleanupTotalsPipeline, getCleanupSettings } from "@/lib/cleanup";
import { getSharedDomain } from "@/lib/config";
import { getConfirmationContent, getConfirmationProblem } from "@/lib/confirmation-content";
import { listNewslettersWithActiveCounts } from "@/lib/contacts";
import { syncArchiveHosts } from "@/lib/domains";
import { formatWindow } from "@/lib/format";
import {
	REMINDER_HOURS,
	applySharedAddress,
	getNewsletterProblem,
	getSlugFormatProblem,
	mergeNewsletterSettings,
	toNewsletterDocument,
	toNewsletterSettings,
} from "@/lib/newsletter-settings";
import { CUSTOM_HEADER_LIMITS } from "@/lib/custom-headers";
import { SLUG_CHANGES, getNewsletterLimit, getNewsletterLimitMessage } from "@/lib/newsletters";
import { findFreeSlug } from "@/lib/onboarding";
import { getPostalAddress, toPostalAddressFields } from "@/lib/postal-address";
import { isRateLimited } from "@/lib/rate-limit";
import { findAccountDomains } from "@/lib/sender";
import { getEmailDomain, getFromEmailSaveProblem, getSharedAddress } from "@/lib/sender-rules";
import { sendWelcomeTestEmail } from "@/lib/sending";
import { syncSharedSender } from "@/lib/shared-sender";
import { siteExtensions } from "@/lib/site-extensions";
import Contact from "@/models/Contact";
import Newsletter from "@/models/Newsletter";

const GROUP = "Newsletters";
const text = (max) => z.string().trim().max(max);
const email = z.string().trim().toLowerCase().max(254);

const settingsShape = {
	name: text(100).describe("The newsletter's name, shown in emails and on the archive"),
	slug: z
		.string()
		.trim()
		.toLowerCase()
		.max(40)
		.describe(
			"Lowercase letters, digits and dashes, not a name FlockStack keeps like www, api or mail. The shared from address (hello@<slug>.<shared domain>) and the archive subdomain follow it."
		),
	imageUrl: text(500).describe("Square logo, 128×128 or larger: an https:// link"),
	fromName: text(100).describe("Name in the From field"),
	fromEmail: email.describe(
		"The shared address (hello@<slug>.<shared domain>, set automatically) or an address on a domain added to this account"
	),
	replyTo: email.describe("Where replies go. Empty: replies to the shared address go to the account owner."),
	postalAddress: text(500).describe(
		"Printed in the footer of every email. Never set, it's the server's default (FlockStack's address on FlockStack Cloud, none on a self-hosted server); saved empty, there's none and sending waits for one."
	),
	archiveEnabled: z
		.boolean()
		.describe("A public page for each sent issue, with a signup form. On for new newsletters: until the first issue it is one \"first issue coming soon\" page with the signup form, and the issues appear once sent."),
	description: text(1000).describe("One sentence under the name on the archive, 200 characters at most"),
	accentColor: z
		.string()
		.trim()
		.toLowerCase()
		.max(7)
		.describe("The newsletter's accent color, as #rrggbb: buttons, poll answers and links in the email, and buttons and links on the website. Pale colors get a darker shade for text. Empty: near-black."),
	brand: z
		.object({
			theme: z.enum(THEME_IDS).optional().describe("The website's look: classic (the default), magazine, minimal or bold"),
			fontPair: z
				.enum(FONT_PAIR_IDS)
				.optional()
				.describe("Fonts for the website and the email, ones every device has: sans (the default), serif, editorial (serif headlines over sans text), modern (Helvetica headlines over serif text) or helvetica (Helvetica throughout, Arial where a device has no Helvetica)"),
			headerUrl: text(500).optional().describe("A wide image above the issue in the email and at the top of the website: an https:// link. Empty removes it."),
			emailLogo: z.boolean().optional().describe("Show the logo (imageUrl) and the name above the issue in the email"),
		})
		.describe("The brand besides its accent color (accentColor) and its logo (imageUrl): theme, fonts and header image, applied to the email and the website"),
	author: z
		.object({
			bio: text(1000).optional().describe("Under the author's name on the archive, 160 characters at most"),
			imageUrl: text(500).optional().describe("Author photo: an https:// link. The newsletter image otherwise."),
		})
		.describe("The archive's author page; the author's name is fromName"),
	defaultStyle: z
		.object({
			header: z.string().max(20_000).optional().describe("Rich text (HTML, or plain paragraphs) at the top of every new issue, 20,000 characters at most"),
			footer: z.string().max(20_000).optional().describe("Rich text (HTML, or plain paragraphs) at the bottom of every new issue"),
		})
		.describe(
			"The style new issues start with, next to accentColor: a header and a footer around the empty place where the writer starts. They are in the issue as content, so it can change them. They apply to issues started in the dashboard or with create_campaign without content or a template, and to a series' issues; plain paragraphs separated by a blank line become paragraphs."
		),
	jsonLd: text(20_000).describe(
		'Your own structured data for search engines, added to the website\'s home page and every issue\'s page: JSON of one block, or a list of up to 5, each an object with an "@type" (FAQPage, Organization, Event…) or an "@graph". "@context" defaults to https://schema.org. 20,000 characters at most; invalid JSON is refused. Empty removes it. The issue pages already carry their own BlogPosting data.'
	),
	preferencesLink: z
		.boolean()
		.describe("Every email's footer links to the reader's preference center, where they change the custom fields marked readerEditable and unsubscribe. {{preferences_url}} puts the same link in a body."),
	utmLinks: z
		.boolean()
		.describe("Add utm_source (the newsletter's name), utm_medium=email and utm_campaign (the issue's slug) to the links in issues that lead to other sites. A link with UTM parameters of its own keeps them. Off by default."),
	shareButtons: z
		.boolean()
		.describe("Share buttons (X, LinkedIn, Facebook and email) in the header of every email whose issue has a public web page, beside the read online link. An issue can turn them on or off for itself with shareButtons on update_campaign. Off by default."),
	sendUndoSeconds: z
		.number()
		.int()
		.describe("How long the dashboard holds a send after Send is pressed, so it can be undone: 0 (off), 10, 30 (the default) or 60 seconds. Sends from the API and MCP go out at once."),
	customHeaders: z
		.array(z.object({ name: text(CUSTOM_HEADER_LIMITS.name), value: text(CUSTOM_HEADER_LIMITS.value) }))
		.max(CUSTOM_HEADER_LIMITS.count)
		.describe(`Extra headers added to the newsletter's emails, ${CUSTOM_HEADER_LIMITS.count} at most, replacing the saved list: names starting with X- (not X-SES-, X-Amz-, X-PostShiba or X-Feedback), List-Id, List-Archive, List-Help, List-Owner, List-Subscribe, Organization or Keywords, with a value of plain printable text on one line. Anything else is refused, so a header can't change the sender, the signature or the unsubscribe link; the unsubscribe headers always win.`),
	socialLinks: z.array(text(300)).max(20).describe("https:// links shown on the archive, 8 at most"),
	requireConfirmation: z
		.boolean()
		.describe("Confirmed opt-in: new signups get an email with a button and only join once they click it. On for new newsletters."),
	signupApproval: z
		.boolean()
		.describe("Hold new signups for your approval: after they confirm, where confirmation is on, they wait as held contacts and get nothing until you approve them (approve_held_signups) or turn them down (reject_held_signups). A contact you add or who pays is never held. Off by default."),
	privateArchive: z
		.boolean()
		.describe("Make the website private: no issue, list, feed, sitemap or search is public. Every page asks visitors to join or sign in, and only a signed-in active subscriber reads an issue. Pair it with signupApproval to choose who gets in. Off by default."),
	cleanup: z
		.object({
			enabled: z.boolean().optional().describe("On for new newsletters"),
			issues: z.number().nullable().optional().describe("Ignored issues in a row before the last-chance email, 2 to 100. Default 6."),
			days: z.number().nullable().optional().describe("Days without an open, click or signup, 30 to 3650. Default 180."),
		})
		.describe(
			"List cleanup at each send: contacts who ignored several issues get a last-chance email instead, and become dormant if they don't answer"
		),
	welcome: z
		.object({
			enabled: z.boolean().optional(),
			subject: text(200).optional(),
			previewText: text(300).optional(),
			markdown: z.string().max(100_000).optional().describe("Markdown"),
		})
		.describe("Email sent to each new subscriber. Not sent while signups need confirming."),
	confirmation: z
		.object({
			subject: text(200).optional(),
			previewText: text(300).optional(),
			markdown: z
				.string()
				.max(100_000)
				.optional()
				.describe('Markdown that keeps the button: an HTML link like <a href="{{confirm_url}}">Confirm</a>'),
		})
		.describe(
			"The confirmation email for confirmed opt-in. Sent back unchanged, the built-in one stays built-in and follows the name and description."
		),
	confirmationReminder: z
		.object({
			enabled: z.boolean().optional().describe("Off by default"),
			delayHours: z.number().nullable().optional().describe("Hours after signing up, 6 to 168. Default 48."),
		})
		.describe("With confirmed opt-in: one reminder, the confirmation email again, to signups that haven't confirmed after a while"),
	confirmedRedirectUrl: text(500).describe("With confirmed opt-in: an https:// page readers go to once they confirm. Empty: FlockStack's own page."),
};

const NewsletterSchema = z.object({
	id: z.string(),
	name: z.string(),
	slug: z.string(),
	imageUrl: z.string(),
	fromName: z.string(),
	fromEmail: z.string(),
	replyTo: z.string(),
	postalAddress: z.string().describe("What its emails print: its own address, else the server's default"),
	sharedAddress: z.string().nullable().describe("The shared from address for this slug, when the server has a shared domain"),
	archiveEnabled: z.boolean(),
	archiveUrl: z.string().nullable().describe("The website's address while it's on. Until the first issue it shows a \"first issue coming soon\" page with the signup form."),
	description: z.string(),
	accentColor: z.string().describe("#rrggbb, or empty for the default"),
	brand: z.object({
		theme: z.enum(THEME_IDS),
		fontPair: z.enum(FONT_PAIR_IDS),
		headerUrl: z.string().describe("Empty without one"),
		emailLogo: z.boolean(),
	}),
	preferencesLink: z.boolean(),
	utmLinks: z.boolean().describe("Links to other sites in issues get UTM parameters"),
	shareButtons: z.boolean().describe("Share buttons in the header of emails whose issue has a web page"),
	sendUndoSeconds: z.number().int().describe("Seconds the dashboard holds a send for undo: 0, 10, 30 or 60"),
	customHeaders: z.array(z.object({ name: z.string(), value: z.string() })).describe("Extra headers on its emails"),
	defaultStyle: z.object({ header: z.string(), footer: z.string() }).describe("What new issues start with, as HTML"),
	jsonLd: z.string().describe("Its own structured data as compact JSON, or empty"),
	seoUrls: z
		.object({
			sitemap: z.string(),
			robots: z.string(),
			llms: z.string().describe("llms.txt: the newsletter and its latest issues as plain text for AI assistants"),
			feed: z.string(),
		})
		.nullable()
		.describe("Where the website serves its sitemap, robots.txt, llms.txt and RSS feed; null while the website is off"),
	author: z.object({ bio: z.string(), imageUrl: z.string() }),
	socialLinks: z.array(z.string()),
	requireConfirmation: z.boolean(),
	signupApproval: z.boolean().describe("New signups are held for approval"),
	privateArchive: z.boolean().describe("The website shows issues only to signed-in active subscribers"),
	welcome: z.object({
		enabled: z.boolean(),
		subject: z.string(),
		previewText: z.string(),
		markdown: z.string(),
		paused: z
			.boolean()
			.describe("The account used up this month's emails: no welcome email goes out until the count starts over or the plan grows"),
	}),
	confirmation: z.object({
		subject: z.string(),
		previewText: z.string(),
		markdown: z.string(),
		isCustom: z.boolean().describe("False while the built-in confirmation email goes out"),
	}),
	confirmationReminder: z.object({ enabled: z.boolean(), delayHours: z.number().int() }),
	confirmedRedirectUrl: z.string(),
	cleanup: z.object({
		enabled: z.boolean(),
		issues: z.number().int(),
		days: z.number().int(),
		waiting: z.number().int().describe("Got the last-chance email and haven't answered yet"),
		kept: z.number().int().describe("Answered the last-chance email"),
		dormant: z.number().int(),
	}),
	activeContacts: z.number().int(),
	createdAt: dateOutput,
	updatedAt: dateOutput,
});

async function toNewsletter(account, newsletter, activeContacts) {
	const [totals] = await Contact.aggregate(cleanupTotalsPipeline({ accountId: newsletter.accountId, newsletterId: newsletter._id }));
	const { postalAddressCleared, ...settings } = toNewsletterSettings(newsletter);
	const confirmation = getConfirmationContent(newsletter);
	return {
		id: String(newsletter._id),
		...settings,
		postalAddress: getPostalAddress(newsletter, siteExtensions.defaultPostalAddress),
		brand: { ...settings.brand, theme: getBrand(newsletter).theme, fontPair: getBrand(newsletter).fontPair },
		welcome: { ...settings.welcome, paused: areWelcomeEmailsPaused(account) },
		sharedAddress: getSharedAddress(newsletter.slug),
		archiveUrl: newsletter.archiveEnabled ? getArchiveUrls(newsletter).siteIndex : null,
		seoUrls: newsletter.archiveEnabled ? pickSeoUrls(getArchiveUrls(newsletter)) : null,
		confirmation: {
			subject: confirmation.subject,
			previewText: confirmation.previewText,
			markdown: confirmation.markdown,
			isCustom: Boolean(newsletter.confirmation?.subject) && !getConfirmationProblem(newsletter.confirmation),
		},
		confirmationReminder: { enabled: settings.confirmationReminder.enabled, delayHours: settings.confirmationReminder.delayHours ?? REMINDER_HOURS.default },
		cleanup: { ...getCleanupSettings(newsletter), waiting: totals?.waiting ?? 0, kept: totals?.kept ?? 0, dormant: totals?.dormant ?? 0 },
		activeContacts:
			activeContacts ?? (await Contact.countDocuments({ accountId: newsletter.accountId, newsletterId: newsletter._id, status: "active" })),
		createdAt: toIso(newsletter.createdAt),
		updatedAt: toIso(newsletter.updatedAt),
	};
}

function pickSeoUrls({ sitemap, robots, llms, feed }) {
	return { sitemap, robots, llms, feed };
}

const SLUG_TAKEN = "This slug is already used";

// Slugs are unique across accounts (the index on Newsletter.slug); a newsletter's own slug isn't taken for it.
function isSlugTaken(slug, newsletterId = null) {
	return Newsletter.exists({ slug, ...(newsletterId && { _id: { $ne: newsletterId } }) }).setOptions({ crossAccount: true });
}

// A slug another newsletter has is refused before it counts.
async function countSlugChange(account, slug) {
	if (await isSlugTaken(slug)) throw actionError("conflict", SLUG_TAKEN);
	if (await isRateLimited({ ...SLUG_CHANGES, key: String(account._id) })) {
		throw actionError("rate_limited", `You can change slugs ${SLUG_CHANGES.limit} times ${formatWindow(SLUG_CHANGES.window)}. Try again later.`);
	}
}

// The same checks as the settings form: the shared address follows the slug, and a from address is the
// shared one or on a domain the account added.
async function saveNewsletter({ account, existing, changes, externalId }) {
	const merged = mergeNewsletterSettings(toNewsletterSettings(existing), changes);
	const address = "postalAddress" in changes ? toPostalAddressFields(changes.postalAddress, siteExtensions.defaultPostalAddress) : {};
	const settings = applySharedAddress({ ...merged, ...address }, getSharedDomain());
	const problem = getNewsletterProblem(settings);
	if (problem) throw actionError("validation_failed", problem);
	const fromProblem = getFromEmailSaveProblem({ ...settings, domains: await findAccountDomains(account._id) });
	if (fromProblem) throw actionError("sender_not_allowed", fromProblem);
	if (existing && settings.slug !== existing.slug) await countSlugChange(account, settings.slug);

	const document = toNewsletterDocument(settings);
	const changedDomain = existing && getEmailDomain(existing.fromEmail) !== getEmailDomain(settings.fromEmail);
	if (changedDomain) document.senderChangedAt = new Date();
	let id = existing?._id;
	try {
		if (existing) {
			const { matchedCount } = await Newsletter.updateOne(scoped(account, { _id: id }), { $set: document, ...(changedDomain && { $unset: { spreadUntil: 1 } }) }, { runValidators: true });
			if (!matchedCount) throw actionError("not_found", "Newsletter not found");
		} else {
			const limit = getNewsletterLimit(account);
			if (limit !== null && (await Newsletter.countDocuments(scoped(account))) >= limit) {
				throw actionError("conflict", getNewsletterLimitMessage(account));
			}
			id = (await Newsletter.create({ ...document, ...(externalId && { externalId }), accountId: account._id }))._id;
		}
	} catch (error) {
		if (error?.code === 11000) throw actionError("conflict", SLUG_TAKEN);
		throw error;
	}

	await syncArchiveHosts(account._id);
	await syncSharedSender({ account, newsletter: await Newsletter.findOne(scoped(account, { _id: id })).lean() });
	revalidateArchive();
	return toNewsletter(account, await Newsletter.findOne(scoped(account, { _id: id })).lean());
}

export const newsletterActions = [
	defineAction({
		name: "list_newsletters",
		tryWithoutPlan: true,
		title: "List newsletters",
		group: GROUP,
		description: "Lists the account's newsletters, first created first, with their settings and active contacts. Actions that take a newsletter use the first one when it's left out.",
		http: { method: "GET", path: "/newsletters" },
		readOnly: true,
		output: z.object({ newsletters: z.array(NewsletterSchema) }),
		handler: async ({ account }) => {
			const newsletters = await listNewslettersWithActiveCounts(account);
			return { newsletters: await Promise.all(newsletters.map((newsletter) => toNewsletter(account, newsletter, newsletter.activeCount))) };
		},
	}),
	defineAction({
		name: "get_newsletter",
		tryWithoutPlan: true,
		title: "Get a newsletter",
		group: GROUP,
		description:
			"Gets a newsletter's settings: sender, postal address, welcome and confirmation emails, list cleanup and archive.",
		http: { method: "GET", path: "/newsletters/{id}" },
		readOnly: true,
		input: z.object({ id: z.string().trim().min(1).max(100).describe("The newsletter's ID or slug") }),
		output: NewsletterSchema,
		handler: async ({ account, input }) => toNewsletter(account, await findNewsletter(account, input.id)),
	}),
	defineAction({
		name: "create_newsletter",
		tryWithoutPlan: true,
		title: "Create a newsletter",
		group: GROUP,
		description:
			`Creates a newsletter within the account's newsletter limit (1 on Free, 3 on Starter, 5 on Growth, 10 on Pro, 25 on Scale and 50 on Max; an admin can override it). They share its plan's emails and subscribers; one more answers conflict. Self-hosted servers have no limit. Without a fromEmail it sends from the shared address hello@<slug>.<shared domain>, which FlockStack sets up in a few minutes. List cleanup is on unless cleanup.enabled is false. Without a postalAddress, its emails print the server's default if it has one: FlockStack's address on FlockStack Cloud.`,
		http: { method: "POST", path: "/newsletters", status: 201 },
		example: { name: "Field notes", postalAddress: "Field Notes Ltd, 1 Main St, Paris, France" },
		input: z.object({
			...Object.fromEntries(Object.entries(settingsShape).map(([key, schema]) => [key, schema.optional()])),
			name: settingsShape.name.min(1),
			externalId: z.string().trim().min(1).max(120).optional().describe("A retry key unique in the account; the same key returns the existing newsletter without changing it."),
			slug: settingsShape.slug
				.optional()
				.describe("Lowercase letters, digits and dashes. Default: made from the name, numbered when another newsletter has it."),
		}),
		output: NewsletterSchema,
		handler: async ({ account, input: { externalId, ...input } }) => {
			if (externalId) {
				const existing = await Newsletter.findOne(scoped(account, { externalId })).lean();
				if (existing) return toNewsletter(account, existing);
			}
			try {
				return await saveNewsletter({ account, existing: null, externalId, changes: { ...input, slug: input.slug || (await findFreeSlug(input.name)) } });
			} catch (error) {
				const made = externalId && await Newsletter.findOne(scoped(account, { externalId })).lean();
				if (made) return toNewsletter(account, made);
				throw error;
			}
		},
	}),
	defineAction({
		name: "update_newsletter",
		tryWithoutPlan: true,
		title: "Update a newsletter",
		group: GROUP,
		description: `Changes a newsletter's settings. Send only the fields to change; nested groups (welcome, confirmation, cleanup, author, brand) keep the fields you leave out. An account changes slugs ${SLUG_CHANGES.limit} times ${formatWindow(SLUG_CHANGES.window)} at most: one more answers rate_limited.`,
		http: { method: "PATCH", path: "/newsletters/{id}" },
		idempotent: true,
		example: { replyTo: "jane@example.com", requireConfirmation: true },
		input: z.object({
			id: z.string().trim().min(1).max(100).describe("The newsletter's ID or slug"),
			...Object.fromEntries(Object.entries(settingsShape).map(([key, schema]) => [key, schema.optional()])),
		}),
		output: NewsletterSchema,
		handler: async ({ account, input: { id, ...changes } }) =>
			saveNewsletter({ account, existing: await findNewsletter(account, id), changes }),
	}),
	defineAction({
		name: "check_newsletter_slug",
		tryWithoutPlan: true,
		title: "Check a slug",
		group: GROUP,
		description: `Says whether a newsletter can take a slug: available, or taken by another newsletter, reserved by FlockStack or invalid, with the message saving it would answer. Checking doesn't count toward the ${SLUG_CHANGES.limit} slug changes ${formatWindow(SLUG_CHANGES.window)}.`,
		http: { method: "GET", path: "/newsletters/slugs/{slug}" },
		readOnly: true,
		rateLimit: { limit: 300, window: "1 h" },
		limitDashboard: true,
		example: { slug: "field-notes" },
		input: z.object({
			slug: z.string().trim().toLowerCase().max(100).describe("The slug to check"),
			id: z.string().trim().max(100).optional().describe("The newsletter that would take it, by ID or slug: its own slug is available to it"),
		}),
		output: z.object({
			slug: z.string(),
			available: z.boolean(),
			reason: z.enum(["taken", "reserved", "invalid"]).nullable().describe("Why it isn't available"),
			message: z.string().nullable(),
		}),
		handler: async ({ account, input }) => {
			const newsletter = input.id ? await findNewsletter(account, input.id, { _id: 1 }) : null;
			const problem =
				getSlugFormatProblem(input.slug) ?? ((await isSlugTaken(input.slug, newsletter?._id)) ? { reason: "taken", message: SLUG_TAKEN } : null);
			return { slug: input.slug, available: !problem, reason: problem?.reason ?? null, message: problem?.message ?? null };
		},
	}),
	defineAction({
		name: "send_welcome_test_email",
		title: "Send a test of the welcome email",
		group: GROUP,
		description: "Sends the saved welcome email to the account owner's address, switched on or not. It counts toward the plan's emails.",
		http: { method: "POST", path: "/newsletters/{id}/welcome-test" },
		openWorld: true,
		rateLimit: { limit: 20, window: "1 h" },
		input: z.object({ id: z.string().trim().min(1).max(100).describe("The newsletter's ID or slug") }),
		output: z.object({ sentTo: z.string(), messageId: z.string() }),
		handler: async ({ account, user, input }) => {
			assertSendingEnabled();
			const newsletter = await findNewsletter(account, input.id, { _id: 1 });
			const to = await findTestRecipient({ account, user });
			const { messageId } = await sendWelcomeTestEmail({ accountId: account._id, newsletterId: newsletter._id, to });
			return { sentTo: to, messageId };
		},
	}),
];
