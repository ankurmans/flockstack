import "server-only";
import { createHash } from "node:crypto";
import { scoped } from "@/lib/account-scope";
import { markdownToHtml } from "@/lib/markdown";
import { READER_LANGUAGES } from "@/lib/reader-languages";
import { htmlToText } from "@/lib/render-email";
import IssueTranslation from "@/models/IssueTranslation";

// A briefing's own translations (lib/briefings-delivery.js): rows of the reader translation cache (models/IssueTranslation.js) marked
// with model "briefing" and keyed by the issue as the briefing wrote it, kept as long as the issue reads the same. lib/reader-translation.js
// gives them to readers who see the whole issue before it would ask a model. Apart from it so the API Worker, which delivers, doesn't
// load the reader side.
export const BRIEFING_TRANSLATION = { model: "briefing", keepDays: 3650, outputChars: 48000 };

// The key of a briefing's translation: the issue's subject and Markdown as the briefing wrote them. An edit to either changes it, and
// readers then get the usual translation on request instead.
export function briefingSourceHash({ subject, markdown }) {
	return `briefing:${createHash("sha256").update(`${subject ?? ""}\n\n${markdown ?? ""}`).digest("hex")}`;
}

// Saves the translate step's Markdown for each other language against the draft, as the plain text readers are shown (beta). Safe
// to repeat.
export async function storeBriefingTranslations({ account, campaign, translations = [], now = new Date() }) {
	const sourceHash = briefingSourceHash(campaign);
	const expiresAt = new Date(+now + BRIEFING_TRANSLATION.keepDays * 86400000);
	let stored = 0;
	for (const { language, markdown } of translations) {
		if (!READER_LANGUAGES.includes(language) || typeof markdown !== "string" || !markdown.trim()) continue;
		const text = htmlToText(markdownToHtml(markdown)).trim().slice(0, BRIEFING_TRANSLATION.outputChars);
		if (!text) continue;
		await IssueTranslation.updateOne(
			scoped(account, { campaignId: campaign._id, language, sourceHash }),
			{ $set: { text, model: BRIEFING_TRANSLATION.model, expiresAt }, $setOnInsert: { newsletterId: campaign.newsletterId } },
			{ upsert: true }
		);
		stored += 1;
	}
	return stored;
}
