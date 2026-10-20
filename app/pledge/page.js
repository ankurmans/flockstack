import { Link2Off } from "lucide-react";
import CardNotice from "@/components/CardNotice";
import FormPledgeCancel from "@/components/FormPledgeCancel";
import { connectDb } from "@/lib/db";
import { readPaidToken } from "@/lib/paid-links";
import { findNewsletterAnywhere } from "@/lib/public-newsletters";

// The URL carries the pledge's token: keep it out of search results and referrer headers.
export const metadata = {
	title: "Cancel your pledge",
	robots: { index: false, follow: false },
	referrer: "no-referrer",
};

export default async function PledgePage({ searchParams }) {
	const { token } = await searchParams;
	const validToken = typeof token === "string" ? token : null;
	const reference = readPaidToken("pledge-cancel", validToken);
	const newsletter = reference ? await getNewsletter(reference.n) : null;

	return (
		<main className="theme-neutral flex min-h-dvh items-center justify-center bg-background px-4 py-16">
			{newsletter ? (
				<FormPledgeCancel token={validToken} newsletterName={newsletter.name} />
			) : (
				<CardNotice icon={Link2Off} title="This link doesn't work">
					It may be too old. Reply to the email it came in if you want your pledge canceled.
				</CardNotice>
			)}
		</main>
	);
}

async function getNewsletter(newsletterId) {
	try {
		await connectDb();
		return await findNewsletterAnywhere({ _id: newsletterId });
	} catch (error) {
		console.error("[pledge] Could not load the newsletter:", error.message);
		return null;
	}
}
