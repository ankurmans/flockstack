import { getBrandProblem } from "./brand.js";
import { cleanRichHtml } from "./clean-html.js";
import { CLEANUP_LIMITS } from "./cleanup.js";
import { checkCustomHeaders } from "./custom-headers.js";
import { ACCENT_PATTERN } from "./editor-blocks.js";
import { getConfirmationProblem, isDefaultConfirmation } from "./confirmation-content.js";
import { MAX_AUTHOR_BIO_LENGTH, MAX_DESCRIPTION_LENGTH, MAX_PUBLISHER_LENGTH } from "./newsletters.js";
import { isReservedSlug } from "./reserved-slugs.js";
import { getSharedAddress, isOnSharedDomain } from "./sender-rules.js";
import { parseSocialLinks } from "./social.js";
import { textToRich } from "./rich-text.js";
import { checkJsonLd } from "./seo-rules.js";
import { getUndoProblem, getUndoSeconds } from "./send-hold-rules.js";
import { MAX_STYLE_LENGTH } from "./templates.js";

export const NEWSLETTER_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const REMINDER_HOURS = { min: 6, max: 168, default: 48 };
export const IMAGE_URL_PATTERN = /^(https:\/\/[^\s"'<>]{4,490}|\/[\w\-./]{1,200})$/;

function isWithin(value, min, max) {
	return value === undefined || value === null || (Number.isInteger(value) && value >= min && value <= max);
}

// What the settings form and the API save, in the stored shape, before any check.
export function toNewsletterSettings(newsletter) {
	return {
		name: newsletter?.name ?? "",
		slug: newsletter?.slug ?? "",
		imageUrl: newsletter?.imageUrl ?? "",
		fromName: newsletter?.fromName ?? "",
		fromEmail: newsletter?.fromEmail ?? "",
		replyTo: newsletter?.replyTo ?? "",
		postalAddress: newsletter?.postalAddress ?? "",
		postalAddressCleared: Boolean(newsletter?.postalAddressCleared),
		// New newsletters start with their website on; it goes live with their first issue (lib/archive-data.js).
		archiveEnabled: newsletter ? Boolean(newsletter.archiveEnabled) : true,
		description: newsletter?.description ?? "",
		accentColor: newsletter?.accentColor ?? "",
		brand: {
			theme: newsletter?.brand?.theme ?? "",
			fontPair: newsletter?.brand?.fontPair ?? "",
			headerUrl: newsletter?.brand?.headerUrl ?? "",
			emailLogo: Boolean(newsletter?.brand?.emailLogo),
			publisher: newsletter?.brand?.publisher ?? "",
			// Unset ("") until the writer chooses, so the default (lib/issue-card.js) applies.
			issueCard: typeof newsletter?.brand?.issueCard === "boolean" ? newsletter.brand.issueCard : "",
		},
		preferencesLink: Boolean(newsletter?.preferencesLink),
		utmLinks: Boolean(newsletter?.utmLinks),
		shareButtons: Boolean(newsletter?.shareButtons),
		sendUndoSeconds: getUndoSeconds(newsletter),
		customHeaders: (newsletter?.customHeaders ?? []).map(({ name, value }) => ({ name, value })),
		author: { bio: newsletter?.author?.bio ?? "", imageUrl: newsletter?.author?.imageUrl ?? "" },
		socialLinks: newsletter?.socialLinks ?? [],
		// New newsletters start with confirmed opt-in: an address typed by someone else, or by a bot, never gets issues.
		requireConfirmation: newsletter ? Boolean(newsletter.requireConfirmation) : true,
		signupApproval: Boolean(newsletter?.signupApproval),
		privateArchive: Boolean(newsletter?.privateArchive),
		// New newsletters start with list cleanup on; a saved newsletter that never stored it stays off.
		cleanup: {
			enabled: newsletter ? Boolean(newsletter.cleanup?.enabled) : true,
			issues: newsletter?.cleanup?.issues ?? null,
			days: newsletter?.cleanup?.days ?? null,
		},
		welcome: {
			enabled: Boolean(newsletter?.welcome?.enabled),
			subject: newsletter?.welcome?.subject ?? "",
			previewText: newsletter?.welcome?.previewText ?? "",
			markdown: newsletter?.welcome?.markdown ?? "",
		},
		confirmation: {
			subject: newsletter?.confirmation?.subject ?? "",
			previewText: newsletter?.confirmation?.previewText ?? "",
			markdown: newsletter?.confirmation?.markdown ?? "",
		},
		confirmationReminder: {
			enabled: Boolean(newsletter?.confirmationReminder?.enabled),
			delayHours: newsletter?.confirmationReminder?.delayHours ?? null,
		},
		confirmedRedirectUrl: newsletter?.confirmedRedirectUrl ?? "",
		defaultStyle: { header: newsletter?.defaultStyle?.header ?? "", footer: newsletter?.defaultStyle?.footer ?? "" },
		jsonLd: newsletter?.jsonLd ?? "",
	};
}

// Changes land on top of the saved settings; nested groups keep the fields a change leaves out. A copy of the
// built-in confirmation email would stop following the name, the description and the built-in text. The form
// may have filled it in before a rename in the same save.
export function mergeNewsletterSettings(current, changes) {
	const merged = { ...current, ...changes };
	for (const group of ["author", "brand", "cleanup", "welcome", "confirmation", "confirmationReminder", "defaultStyle"]) merged[group] = { ...current[group], ...changes[group] };
	if (changes.confirmation && isDefaultConfirmation(merged.confirmation, merged, current)) {
		merged.confirmation = { subject: "", previewText: "", markdown: "" };
	}
	return merged;
}

// The shared address follows the slug, so it stays unique and always matches the archive subdomain.
export function applySharedAddress(settings, sharedDomain) {
	const isSharedOrEmpty = !settings.fromEmail || isOnSharedDomain(settings.fromEmail, sharedDomain);
	if (!sharedDomain || !NEWSLETTER_SLUG_PATTERN.test(settings.slug) || !isSharedOrEmpty) return settings;
	return { ...settings, fromEmail: getSharedAddress(settings.slug, sharedDomain) };
}

// reason: invalid or reserved, for the settings form's slug check.
export function getSlugFormatProblem(slug) {
	if (!NEWSLETTER_SLUG_PATTERN.test(slug)) return { reason: "invalid", message: "Slug can only use lowercase letters, numbers and dashes" };
	if (isReservedSlug(slug)) return { reason: "reserved", message: `${slug} is reserved for FlockStack, pick another slug` };
	return null;
}

export function getNewsletterProblem(settings) {
	if (!settings.name) return "Name is required";
	const slugProblem = getSlugFormatProblem(settings.slug);
	if (slugProblem) return slugProblem.message;
	if (settings.imageUrl && !IMAGE_URL_PATTERN.test(settings.imageUrl)) {
		return "Image must be an https:// link or a path like /logos/name.webp";
	}
	if (!EMAIL_PATTERN.test(settings.fromEmail)) return "From email is invalid";
	if (settings.replyTo && !EMAIL_PATTERN.test(settings.replyTo)) return "Reply-to email is invalid";
	if (settings.description.length > MAX_DESCRIPTION_LENGTH) {
		return `Keep the description under ${MAX_DESCRIPTION_LENGTH} characters`;
	}
	if (settings.accentColor && !ACCENT_PATTERN.test(settings.accentColor)) return "Accent color must be a hex color like #1f6feb";
	const undoProblem = getUndoProblem(settings.sendUndoSeconds);
	if (undoProblem) return undoProblem;
	const headerProblem = checkCustomHeaders(settings.customHeaders).problem;
	if (headerProblem) return headerProblem;
	const brandProblem = getBrandProblem(settings.brand);
	if (brandProblem) return brandProblem;
	if (settings.brand.headerUrl && !IMAGE_URL_PATTERN.test(settings.brand.headerUrl)) {
		return "Header image must be an https:// link";
	}
	if (toPublisherLine(settings.brand.publisher).length > MAX_PUBLISHER_LENGTH) return `Keep the publisher line under ${MAX_PUBLISHER_LENGTH} characters`;
	if (settings.author.bio.length > MAX_AUTHOR_BIO_LENGTH) {
		return `Keep the author bio under ${MAX_AUTHOR_BIO_LENGTH} characters`;
	}
	if (settings.author.imageUrl && !IMAGE_URL_PATTERN.test(settings.author.imageUrl)) {
		return "Author photo must be an https:// link or a path like /authors/name.jpg";
	}
	const social = parseSocialLinks(settings.socialLinks.join("\n"));
	if (social.error) return social.error;
	const { minIssues, maxIssues, minDays, maxDays } = CLEANUP_LIMITS;
	if (!isWithin(settings.cleanup.issues, minIssues, maxIssues)) {
		return `Ignored issues should be a whole number from ${minIssues} to ${maxIssues}`;
	}
	if (!isWithin(settings.cleanup.days, minDays, maxDays)) {
		return `Quiet days should be a whole number from ${minDays} to ${maxDays}`;
	}
	if (!isWithin(settings.confirmationReminder.delayHours, REMINDER_HOURS.min, REMINDER_HOURS.max)) {
		return `The reminder goes ${REMINDER_HOURS.min} to ${REMINDER_HOURS.max} hours after signing up`;
	}
	if (settings.confirmedRedirectUrl && !isHttpsUrl(settings.confirmedRedirectUrl)) {
		return "The page after confirming must be an https:// link";
	}
	if (settings.defaultStyle.header.length > MAX_STYLE_LENGTH || settings.defaultStyle.footer.length > MAX_STYLE_LENGTH) {
		return "Keep the header and the footer under 20,000 characters each";
	}
	const jsonLdProblem = checkJsonLd(settings.jsonLd).problem;
	if (jsonLdProblem) return jsonLdProblem;
	if (settings.welcome.enabled && (!settings.welcome.subject || !settings.welcome.markdown.trim())) {
		return "Welcome email needs a subject and content";
	}
	// Without a confirmation email of its own, the built-in one goes out (lib/confirmation-content.js).
	const hasOwnConfirmation = Boolean(settings.confirmation.subject || settings.confirmation.markdown.trim());
	return settings.requireConfirmation && hasOwnConfirmation ? getConfirmationProblem(settings.confirmation) : null;
}

// Plain text on one line: it's printed as text in the website's header, the email's and the share card.
function toPublisherLine(value) {
	return String(value ?? "").replace(/\s+/g, " ").trim();
}

function isHttpsUrl(value) {
	if (value.length > 500) return false;
	try {
		return new URL(value).protocol === "https:";
	} catch {
		return false;
	}
}

// The document to save: empty numbers fall back to the newsletter's defaults, links lose duplicates.
export function toNewsletterDocument(settings) {
	const { issues, days, ...cleanup } = settings.cleanup;
	const { delayHours, ...reminder } = settings.confirmationReminder;
	return {
		...settings,
		confirmationReminder: { ...reminder, ...(delayHours !== null && delayHours !== undefined && { delayHours }) },
		socialLinks: parseSocialLinks(settings.socialLinks.join("\n")).links,
		customHeaders: checkCustomHeaders(settings.customHeaders).headers ?? [],
		brand: Object.fromEntries(Object.entries({ ...settings.brand, publisher: toPublisherLine(settings.brand.publisher) }).filter(([, value]) => value !== "" && value !== null && value !== undefined)),
		jsonLd: checkJsonLd(settings.jsonLd).text,
		defaultStyle: { header: cleanRichHtml(textToRich(settings.defaultStyle.header)), footer: cleanRichHtml(textToRich(settings.defaultStyle.footer)) },
		cleanup: { ...cleanup, ...(issues !== null && issues !== undefined && { issues }), ...(days !== null && days !== undefined && { days }) },
	};
}
