import { getReaderText, getReaderLanguage } from "./reader-languages.js";
export const KEEP_URL_PLACEHOLDER = "{{keep_url}}";

// What a cold contact gets instead of an issue (lib/cleanup.js). One question, one button.
export function getLastChanceContent(newsletter) {
	const name = newsletter?.name?.trim() || "this newsletter";
	if (getReaderLanguage(newsletter) !== "en") {
		const t = getReaderText(newsletter);
		return { format: "markdown", subject: t("Do you still want {name}?", { name }), previewText: t("One click and it keeps coming."), markdown: `${t("Do you still want {name}?", { name })}\n\n<a href="${KEEP_URL_PLACEHOLDER}">${t("Yes, keep sending it")}</a>\n\n${t("If you don't confirm, this is the last email you'll receive.")}` };
	}
	return {
		format: "markdown",
		subject: `Do you still want ${name}?`,
		previewText: "Click the button, and it keeps coming.",
		markdown: `**Do you still want ${name}?**

You haven't opened it in a while, so I'm checking before I stop sending it.

<a href="${KEEP_URL_PLACEHOLDER}" style="display:inline-block;background:#18181b;color:#ffffff;text-decoration:none;font-size:17px;font-weight:600;padding:14px 28px;border-radius:10px;">Yes, keep sending it</a>

If I don't hear from you, this is the last ${name} email you'll get.`,
	};
}
