import { ClipboardList, Link2Off } from "lucide-react";
import CardNotice from "@/components/CardNotice";
import FormSurveyResponse from "@/components/FormSurveyResponse";
import { verifySubscriberToken } from "@/lib/subscriber-links";
import { findPublicSurvey } from "@/lib/surveys";

// The URL can carry a subscriber's survey token: keep it out of search results and referrer headers.
export const metadata = {
	title: "Survey",
	robots: { index: false, follow: false },
	referrer: "no-referrer",
};

// A newsletter's survey on its own host: from a subscriber's link (after signing up, in an email) or for anyone.
export default async function SurveyPage({ searchParams }) {
	const { s, token, from } = await searchParams;
	const survey = await findPublicSurvey(typeof s === "string" ? s : "").catch(() => null);
	const readerToken = typeof token === "string" && verifySubscriberToken("survey", token) ? token : null;

	return (
		<main className="theme-neutral flex min-h-dvh items-center justify-center bg-background px-4 py-16">
			{!survey ? (
				<CardNotice icon={Link2Off} title="This survey is gone">
					Its newsletter took it down.
				</CardNotice>
			) : survey.closed ? (
				<CardNotice icon={ClipboardList} title={survey.title}>
					This survey is closed. Thanks for stopping by.
				</CardNotice>
			) : (
				<div className="w-full max-w-md rounded-xl bg-card p-6 shadow-border animate-enter sm:p-8">
					<h1 className="text-lg font-semibold tracking-tight text-balance">{survey.title}</h1>
					{survey.intro && <p className="mt-1.5 text-sm leading-relaxed text-pretty text-muted-foreground">{survey.intro}</p>}
					<FormSurveyResponse
						survey={{ id: String(survey._id), questions: survey.questions }}
						token={readerToken}
						source={from === "signup" || from === "unsubscribe" ? from : "page"}
						className="mt-6"
					/>
				</div>
			)}
		</main>
	);
}
