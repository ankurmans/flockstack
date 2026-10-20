import "server-only";
import { getAccent } from "@/lib/editor-blocks";
import { getArchiveUrls } from "@/lib/archive-hosts";
import { listArchiveIssues } from "@/lib/archive-data";
import { renderIssueBody } from "@/lib/archive-content";
import { getGateTeaserOptions, getPopupSettings, isGatedIssue } from "@/lib/popup-rules";
import { makeTeaser } from "@/lib/paywall";
import { getPollVoteUrl } from "@/lib/subscriber-links";

// An issue's page the way every reader of the website gets it: the same body the page prints, whoever asks.
export function renderArchiveBody({ newsletter, issue, recommendations = [] }) {
	return renderIssueBody(issue, {
		referralLink: `${getArchiveUrls(newsletter).siteIndex}#subscribe`,
		recommendations,
		accent: getAccent(newsletter),
		pollUrl: (pollId, option) => getPollVoteUrl(null, newsletter, { pollId, option }),
	});
}

// The IDs of the issues the gate leaves open: the newest ones the archive lists.
export async function listFreeIssueIds(newsletter, popup = getPopupSettings(newsletter)) {
	if (!popup.gate.enabled || popup.gate.freeLatest === 0) return [];
	return (await listArchiveIssues(newsletter, { limit: popup.gate.freeLatest })).map(({ _id }) => _id);
}

export async function isGatedFor(newsletter, issue) {
	const popup = getPopupSettings(newsletter);
	return isGatedIssue(popup, issue, await listFreeIssueIds(newsletter, popup));
}

// What the page prints for a gated issue: its beginning, as escaped plain text.
export function getGatePreview(newsletter, issue) {
	return makeTeaser(issue, getGateTeaserOptions(getPopupSettings(newsletter)));
}
