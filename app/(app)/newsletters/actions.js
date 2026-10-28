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

// The custom headers box: one "Name: value" a line. The action checks them.
function readHeaderLines(text) {
	return text
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => {
			const colon = line.indexOf(":");
			return colon === -1 ? { name: line, value: "" } : { name: line.slice(0, colon).trim(), value: line.slice(colon + 1).trim() };
		});
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
		accentColor: readText(formData, "accentColor"),
		brand: {
			theme: readText(formData, "theme") || "classic",
			fontPair: readText(formData, "fontPair") || "sans",
			headerUrl: readText(formData, "headerUrl"),
			emailLogo: formData.get("emailLogo") === "on",
		},
		preferencesLink: formData.get("preferencesLink") === "on",
		utmLinks: formData.get("utmLinks") === "on",
		shareButtons: formData.get("shareButtons") === "on",
		...(formData.has("customHeaders") && { customHeaders: readHeaderLines(String(formData.get("customHeaders") ?? "")) }),
		...(formData.has("sendUndoSeconds") && { sendUndoSeconds: Number(readText(formData, "sendUndoSeconds")) }),
		author: { bio: readText(formData, "authorBio"), imageUrl: readText(formData, "authorImageUrl") },
		socialLinks: readText(formData, "socialLinks").split(/[\s,]+/).filter(Boolean),
		requireConfirmation: formData.get("requireConfirmation") === "on",
		signupApproval: formData.get("signupApproval") === "on",
		privateArchive: formData.get("privateArchive") === "on",
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

// The newsletter's own structured data for search engines; empty removes it.
export async function saveJsonLd(newsletterId, text) {
	const { output, failure } = await runDashboardAction("update_newsletter", { id: String(newsletterId ?? ""), jsonLd: String(text ?? "") });
	if (failure) return toFormError(failure);
	revalidatePath("/newsletters");
	return { ok: true, jsonLd: output.jsonLd };
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

// The website's subfolder on the owner's own site (lib/mounts.js), on the settings page. The token comes back once.
export async function setMount(newsletterId, url) {
	const { output, failure } = await runDashboardAction("set_newsletter_mount", { id: String(newsletterId ?? ""), url: String(url ?? "") });
	if (failure) return toFormError(failure);
	revalidatePath("/newsletters");
	return output;
}

export async function checkMount(newsletterId) {
	const { output, failure } = await runDashboardAction("check_newsletter_mount", { id: String(newsletterId ?? "") });
	if (failure) return toFormError(failure);
	revalidatePath("/newsletters");
	return output;
}

export async function rotateMountToken(newsletterId) {
	const { output, failure } = await runDashboardAction("rotate_newsletter_mount_token", { id: String(newsletterId ?? "") });
	return failure ? toFormError(failure) : output;
}

export async function removeMount(newsletterId) {
	const { failure } = await runDashboardAction("remove_newsletter_mount", { id: String(newsletterId ?? "") });
	if (failure) return toFormError(failure);
	revalidatePath("/newsletters");
	return { ok: true };
}
