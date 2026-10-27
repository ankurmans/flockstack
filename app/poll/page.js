import ProviderReaderLanguage from "@/components/ProviderReaderLanguage";
import { getReaderText } from "@/lib/reader-languages";
import { getPublicReaderLanguage } from "@/lib/public-newsletters";
import { Link2Off } from "lucide-react";
import CardNotice from "@/components/CardNotice";
import FormPollVote from "@/components/FormPollVote";
import { findPublicPoll } from "@/lib/polls";

// The URL can carry a subscriber's vote token: keep it out of search results and referrer headers.
export const metadata = {
	title: "Vote",
	robots: { index: false, follow: false },
	referrer: "no-referrer",
};

// Where a vote link lands, from an email (with the subscriber's token) or from the website (without).
export default async function PollPage({ searchParams }) {
	const { p, o, token } = await searchParams;
	const poll = await findPublicPoll(typeof p === "string" ? p : "").catch(() => null);
	const option = Number(o);
	const answer = poll && Number.isInteger(option) ? poll.options[option]?.label : null;

	const language = await getPublicReaderLanguage(poll?.newsletterId);
	const t = getReaderText(language);

	return (
		<ProviderReaderLanguage language={language}><main className="theme-neutral flex min-h-dvh items-center justify-center bg-background px-4 py-16">
			{answer ? (
				<FormPollVote pollId={String(poll._id)} option={option} token={typeof token === "string" ? token : null} question={poll.question} answer={answer} />
			) : (
				<CardNotice icon={Link2Off} title={t("This link doesn't work")}>
					The poll may be gone. Open the link from the email or the website again.
				</CardNotice>
			)}
		</main></ProviderReaderLanguage>
	);
}
