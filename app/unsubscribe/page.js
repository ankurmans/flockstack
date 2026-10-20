import { CircleAlert, Link2Off, MailCheck, MailX } from "lucide-react";
import FormSurveyResponse from "@/components/FormSurveyResponse";
import { Button } from "@/components/ui/button";
import { connectDb } from "@/lib/db";
import { findNewsletterAnywhere } from "@/lib/public-newsletters";
import { createSubscriberToken } from "@/lib/subscriber-links";
import { findPlacedSurvey } from "@/lib/surveys";
import { verifyUnsubscribeToken } from "@/lib/unsubscribe";
import Contact from "@/models/Contact";

// The URL carries the unsubscribe token: keep it out of search results and referrer headers.
export const metadata = {
	title: "Unsubscribe",
	robots: { index: false, follow: false },
	referrer: "no-referrer",
};

const SUBSCRIBED_STATUSES = ["active", "dormant"];

export default async function UnsubscribePage({ searchParams }) {
	const { token, status } = await searchParams;
	const validToken = typeof token === "string" ? token : null;
	const reference = verifyUnsubscribeToken(validToken);
	const subscription = reference ? await getSubscription(reference) : null;
	const view = getView({ reference, status, subscription });
	const { icon: Icon, title, description } = getCopy(view, subscription?.newsletterName);
	const hasForm = view === "confirm" || view === "error";
	// Once they've left, the newsletter's unsubscribe survey asks why, as that subscriber.
	const survey = view === "done" && subscription?.newsletter ? await getLeavingSurvey(subscription.newsletter) : null;

	return (
		<main className="theme-neutral flex min-h-dvh flex-col items-center justify-center bg-background px-4 py-16">
			<div className="w-full max-w-sm rounded-xl bg-card p-6 text-center shadow-border sm:p-8">
				<div className="mx-auto flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
					<Icon className="size-5" aria-hidden="true" />
				</div>
				<h1 className="mt-4 text-lg font-semibold tracking-tight text-balance">{title}</h1>
				<p className="mt-1.5 text-sm leading-relaxed text-pretty text-muted-foreground">
					{description}
				</p>

				{hasForm && (
					<form method="post" action={`/api/unsubscribe?token=${validToken}`} className="mt-6">
						<input type="hidden" name="source" value="page" />
						<Button type="submit" size="lg" className="w-full">
							Unsubscribe
						</Button>
					</form>
				)}
			</div>
			{survey && (
				<div className="mt-4 w-full max-w-sm rounded-xl bg-card p-6 shadow-border sm:p-8">
					<h2 className="text-base font-semibold tracking-tight text-balance">{survey.title}</h2>
					{survey.intro && <p className="mt-1.5 text-sm text-pretty text-muted-foreground">{survey.intro}</p>}
					<FormSurveyResponse
						survey={{ id: String(survey._id), questions: survey.questions }}
						token={createSubscriberToken("survey", reference)}
						source="unsubscribe"
						className="mt-5"
					/>
				</div>
			)}
		</main>
	);
}

async function getSubscription({ contactId, newsletterId }) {
	try {
		await connectDb();
		const newsletter = await findNewsletterAnywhere({ _id: newsletterId });
		const contact =
			newsletter &&
			(await Contact.findOne({ accountId: newsletter.accountId, _id: contactId, newsletterId })
				.select({ status: 1 })
				.lean());
		return {
			newsletter,
			newsletterName: newsletter?.name,
			isSubscribed: !contact || SUBSCRIBED_STATUSES.includes(contact.status),
		};
	} catch (error) {
		console.error("[unsubscribe] Could not load the subscription:", error.message);
		return { isSubscribed: true };
	}
}

async function getLeavingSurvey(newsletter) {
	try {
		return await findPlacedSurvey(newsletter, "onUnsubscribe");
	} catch (error) {
		console.error("[unsubscribe] Could not load the survey:", error.message);
		return null;
	}
}

function getView({ reference, status, subscription }) {
	if (!reference) return "invalid";
	if (status === "done" || status === "error") return status;
	return subscription?.isSubscribed === false ? "done" : "confirm";
}

function getCopy(view, newsletterName) {
	const name = newsletterName || "this newsletter";
	return {
		invalid: {
			icon: Link2Off,
			title: "This link doesn't work",
			description:
				"Open the unsubscribe link from the email again, or reply to the email to ask to be removed.",
		},
		confirm: {
			icon: MailX,
			title: `Unsubscribe from ${name}?`,
			description: "You'll stop receiving its emails.",
		},
		error: {
			icon: CircleAlert,
			title: "Something went wrong",
			description: `You're still subscribed to ${name}. Try again in a minute.`,
		},
		done: {
			icon: MailCheck,
			title: "You're unsubscribed",
			description: `You won't receive emails from ${name} anymore.`,
		},
	}[view];
}
