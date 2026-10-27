import { getContactTierId, getNewsletterTiers } from "./tier-rules.js";
import { getReaderText } from "./reader-languages.js";
import { renderIssueBody } from "./archive-content.js";
import { getArchiveUrls } from "./archive-hosts.js";
import { getAccent } from "./editor-blocks.js";
import { getPollVoteUrl } from "./subscriber-links.js";

// An issue as its web page shows it, for the page itself and for a paid reader's browser, which asks for the whole issue
// once it knows who is reading (lib/reader-access.js). recommendations: the newsletter's live ones.
export function renderWebIssue({ newsletter, issue, recommendations, isUnlocked = false, readerTier = isUnlocked ? "paid" : "free", reader = null }) {
	const urls = getArchiveUrls(newsletter);
	return renderIssueBody(issue, {
		referralLink: `${urls.siteIndex}#subscribe`,
		recommendations,
		accent: getAccent(newsletter),
		contentsLabel: getReaderText(newsletter)("Contents"),
		pollUrl: (pollId, option) => getPollVoteUrl(null, newsletter, { pollId, option }),
		isUnlocked, readerTier, readerTierId: reader ? getContactTierId(reader) : null, tiers: getNewsletterTiers(newsletter),
	});
}
