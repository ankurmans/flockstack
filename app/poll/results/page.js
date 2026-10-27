import { getReaderText } from "@/lib/reader-languages";
import ProviderReaderLanguage from "@/components/ProviderReaderLanguage";
import { headers } from "next/headers";
import { Link2Off, Lock, Vote } from "lucide-react";
import CardNotice from "@/components/CardNotice";
import FormPollFollowUp from "@/components/FormPollFollowUp";
import { getArchiveUrls } from "@/lib/archive-hosts";
import { countVotes, findPublicPoll, findVote } from "@/lib/polls";
import { findNewsletterAnywhere } from "@/lib/public-newsletters";
import { getClientIp } from "@/lib/rate-limit";
import { cn } from "@/lib/utils";

export const metadata = {
	title: "Poll results",
	robots: { index: false, follow: false },
	referrer: "no-referrer",
};

const STATUS_COPY = {
	closed: "This poll is closed, so your vote wasn't counted.",
	gone: "This link is for a subscriber, and that subscription has ended, so the vote wasn't counted.",
};

// After a vote: the reader's answer, the results so far when the poll shows them, other answers to change to, and the
// follow-up question.
export default async function PollResultsPage({ searchParams }) {
	const { p, token, status } = await searchParams;
	const poll = await findPublicPoll(typeof p === "string" ? p : "").catch(() => null);
	if (!poll) {
		return (
			<main className="theme-neutral flex min-h-dvh items-center justify-center bg-background px-4 py-16">
				<CardNotice icon={Link2Off} title="This poll is gone">
					Its newsletter took it down.
				</CardNotice>
			</main>
		);
	}
	const readerToken = typeof token === "string" ? token : null;
	const [newsletter, vote, counts] = await Promise.all([
		findNewsletterAnywhere({ _id: poll.newsletterId }),
		findVote(poll, { token: readerToken, ip: getClientIp(await headers()) }),
		poll.showResults === false ? null : countVotes(poll),
	]);
	const t = getReaderText(newsletter);
	const total = counts?.reduce((sum, row) => sum + row.total, 0) ?? 0;
	const voteUrl = (option) => `/poll?${new URLSearchParams({ p: String(poll._id), o: String(option), ...(readerToken && { token: readerToken }) })}`;
	const note = STATUS_COPY[status] ?? (vote ? "Thanks for voting. Pick another answer to change yours." : "Pick an answer to vote.");

	return (
		<ProviderReaderLanguage language={t.language}><main className="theme-neutral flex min-h-dvh items-center justify-center bg-background px-4 py-16">
			<CardNotice icon={poll.closed ? Lock : Vote} tone={vote && !status ? "success" : undefined} title={poll.question}>
				<p>{t(note)}</p>
				<ol className="mt-6 flex flex-col gap-2 text-left">
					{poll.options.map(({ label }, index) => {
						const isMine = vote?.option === index;
						const share = counts && total > 0 ? Math.round((counts[index].total / total) * 100) : null;
						const content = (
							<>
								{share !== null && <span aria-hidden="true" className="absolute inset-y-0 left-0 rounded-lg bg-muted" style={{ width: `${share}%` }} />}
								<span className="relative flex items-center justify-between gap-3">
									<span className={cn("min-w-0 truncate", isMine && "font-semibold text-foreground")}>
										{label}
										{isMine && <span className="sr-only"> ({t("Your answer")})</span>}
									</span>
									{share !== null && <span className="shrink-0 tabular-nums">{share}%</span>}
								</span>
							</>
						);
						const className = cn("relative block overflow-hidden rounded-lg px-3 py-2 text-sm shadow-border", isMine && "ring-2 ring-ring");
						return (
							<li key={label}>
								{poll.closed || isMine ? (
									<span className={className}>{content}</span>
								) : (
									<a href={voteUrl(index)} rel="nofollow" className={cn(className, "transition-colors hover:bg-accent")}>
										{content}
									</a>
								)}
							</li>
						);
					})}
				</ol>
				{counts && <p className="mt-3 text-xs tabular-nums">{t("{count} votes so far", { count: new Intl.NumberFormat(t.language).format(total) })}</p>}
				{poll.followUp && vote && !poll.closed && (
					<FormPollFollowUp pollId={String(poll._id)} token={readerToken} question={poll.followUp} defaultValue={vote.comment ?? ""} />
				)}
				{newsletter?.archiveEnabled && (
					<a href={getArchiveUrls(newsletter).siteIndex} className="mt-6 inline-block text-sm font-medium text-foreground underline underline-offset-4">
						{newsletter.name}
					</a>
				)}
			</CardNotice>
		</main></ProviderReaderLanguage>
	);
}
