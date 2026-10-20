"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { runDashboardAction, toFormError } from "@/lib/actions/dashboard";
import { getSelectedNewsletter, saveSelectedNewsletter, switchNewsletter } from "@/lib/selected-newsletter";
import { siteExtensions } from "@/lib/site-extensions";

function readText(formData, key) {
	return String(formData.get(key) ?? "").trim();
}

// Empty stays unset, so the newsletter's default applies.
function readNumber(formData, key) {
	const text = readText(formData, key);
	return text ? Number(text) : null;
}

// A collapsed email section sends no fields, and what it had saved stays as it is.
function readSettings(formData) {
	return {
		name: readText(formData, "name"),
		slug: readText(formData, "slug"),
		imageUrl: readText(formData, "imageUrl"),
		fromName: readText(formData, "fromName"),
		fromEmail: readText(formData, "fromEmail"),
		replyTo: readText(formData, "replyTo"),
		postalAddress: readText(formData, "postalAddress"),
		archiveEnabled: formData.get("archiveEnabled") === "on",
		description: readText(formData, "description"),
		author: { bio: readText(formData, "authorBio"), imageUrl: readText(formData, "authorImageUrl") },
		socialLinks: readText(formData, "socialLinks").split(/[\s,]+/).filter(Boolean),
		requireConfirmation: formData.get("requireConfirmation") === "on",
		cleanup: {
			enabled: formData.get("cleanupEnabled") === "on",
			issues: readNumber(formData, "cleanupIssues"),
			days: readNumber(formData, "cleanupDays"),
		},
		...(formData.has("welcomeSubject") && {
			welcome: {
				enabled: formData.get("welcomeEnabled") === "on",
				subject: readText(formData, "welcomeSubject"),
				previewText: readText(formData, "welcomePreviewText"),
				markdown: String(formData.get("welcomeMarkdown") ?? ""),
			},
		}),
		...(formData.has("confirmationSubject") && {
			confirmation: {
				subject: readText(formData, "confirmationSubject"),
				previewText: readText(formData, "confirmationPreviewText"),
				markdown: String(formData.get("confirmationMarkdown") ?? ""),
			},
			confirmationReminder: {
				enabled: formData.get("confirmationReminderEnabled") === "on",
				delayHours: readNumber(formData, "confirmationReminderHours"),
			},
			confirmedRedirectUrl: readText(formData, "confirmedRedirectUrl"),
		}),
	};
}

// The slug field asks as its value settles: available, or why not.
export async function checkSlug(slug, newsletterId) {
	const { output, failure } = await runDashboardAction("check_newsletter_slug", {
		slug: String(slug ?? ""),
		...(newsletterId && { id: String(newsletterId) }),
	});
	return failure ? toFormError(failure) : output;
}

export async function sendWelcomeTest(newsletterId) {
	const { failure } = await runDashboardAction("send_welcome_test_email", { id: String(newsletterId ?? "") });
	return failure ? toFormError(failure) : { ok: true };
}

export async function saveNewsletter(_state, formData) {
	const id = readText(formData, "id");
	const settings = readSettings(formData);
	const { output, failure } = id
		? await runDashboardAction("update_newsletter", { id, ...settings })
		: await runDashboardAction("create_newsletter", settings);
	if (failure) return toFormError(failure);
	revalidatePath("/newsletters");
	if (!id) redirect(`/newsletters/${output.id}`);
	return { ok: true, savedAt: Date.now() };
}

// The newsletter menu. Which newsletter the dashboard shows is its own state, a cookie: no action of the API runs.
export async function selectNewsletter(id, pathname) {
	return switchNewsletter(id, pathname);
}

// Add a newsletter: a name and a description. The sender's name and postal address are the newsletter's that was
// open, so it can send once its settings look right; without a shared domain, the form also asks for its address.
export async function createNewsletter(_state, formData) {
	const name = readText(formData, "name");
	if (!name) return { error: "Name your newsletter" };
	const { selected } = await getSelectedNewsletter();
	const fromEmail = readText(formData, "fromEmail");
	const { output, failure } = await runDashboardAction("create_newsletter", {
		name,
		description: readText(formData, "description"),
		...(fromEmail && { fromEmail }),
		...(selected?.fromName && { fromName: selected.fromName }),
		...(selected?.postalAddress && { postalAddress: selected.postalAddress }),
	});
	if (failure) return toFormError(failure);
	await saveSelectedNewsletter(output.id);
	await siteExtensions.sendGoalOnNextPage("newsletter_created");
	redirect("/newsletters");
}

// The website's redirects, on the settings page.
export async function listRedirects(newsletterId, cursor) {
	const { output, failure } = await runDashboardAction("list_redirects", { newsletter: String(newsletterId ?? ""), ...(cursor && { cursor: String(cursor) }) });
	return failure ? toFormError(failure) : output;
}

export async function addRedirect(newsletterId, from, to) {
	const { output, failure } = await runDashboardAction("add_redirect", { newsletter: String(newsletterId ?? ""), from: String(from ?? ""), to: String(to ?? "") });
	return failure ? toFormError(failure) : { redirect: output };
}

export async function deleteRedirect(id) {
	const { failure } = await runDashboardAction("delete_redirect", { id: String(id ?? "") });
	return failure ? toFormError(failure) : { ok: true };
}

export async function importRedirects(newsletterId, csv) {
	const { output, failure } = await runDashboardAction("import_redirects", { newsletter: String(newsletterId ?? ""), csv: String(csv ?? "") });
	return failure ? toFormError(failure) : output;
}
