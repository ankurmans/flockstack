import "server-only";
import { listArchiveIssues } from "@/lib/archive-data";
import { getGateTeaserOptions, getPopupSettings, isGatedIssue } from "@/lib/popup-rules";
import { makeTeaser } from "@/lib/paywall";

// The IDs of the issues the gate leaves open: the newest ones the archive lists.
export async function listFreeIssueIds(newsletter, popup = getPopupSettings(newsletter)) {
	if (!popup.gate.enabled || popup.gate.freeLatest === 0) return [];
	return (await listArchiveIssues(newsletter, { limit: popup.gate.freeLatest })).map(({ _id }) => _id);
}

export async function isGatedFor(newsletter, issue) {
	if (newsletter.privateArchive) return true;
	const popup = getPopupSettings(newsletter);
	return isGatedIssue(popup, issue, await listFreeIssueIds(newsletter, popup));
}

// What the page prints for a gated issue: its beginning, as escaped plain text.
export function getGatePreview(newsletter, issue) {
	return makeTeaser(issue, getGateTeaserOptions(getPopupSettings(newsletter)));
}
