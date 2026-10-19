import { Link2Off, MailCheck, MailX } from "lucide-react";
import CardNotice from "@/components/CardNotice";
import { Button } from "@/components/ui/button";
import { connectDb } from "@/lib/db";
import { findOpenNewsletter } from "@/lib/public-newsletters";
import { verifyReaderToken } from "@/lib/reader-links";
import { setReplyEmails } from "@/app/reader/replies/actions";
import Contact from "@/models/Contact";

// The URL carries a signed token: keep it out of search results and referrer headers.
export const metadata = {
	title: "Emails about replies",
	robots: { index: false, follow: false },
	referrer: "no-referrer",
};

export const dynamic = "force-dynamic";

// The link at the end of an email about a reply: whether this reader gets those emails. Opening the page changes nothing.
export default async function RepliesPage({ searchParams }) {
	const { token } = await searchParams;
	const validToken = typeof token === "string" ? token : "";
	const page = await findPage(validToken);

	return (
		<main className="theme-neutral flex min-h-dvh items-center justify-center bg-background px-4 py-16">
			{!page ? (
				<CardNotice icon={Link2Off} title="This link doesn't work">
					Open the link in the newest email you got about a reply.
				</CardNotice>
			) : (
				<CardNotice icon={page.isOff ? MailX : MailCheck} title={page.isOff ? "Reply emails are off" : "Emails about replies are on"}>
					{page.isOff
						? `You won't get an email when someone replies to your comments on ${page.newsletter.name}. Replies still show on its website.`
						: `You get an email, once, when someone replies to your comments on ${page.newsletter.name}.`}
					<form action={setReplyEmails} className="mt-6">
						<input type="hidden" name="token" value={validToken} />
						{page.isOff ? <input type="hidden" name="emails" value="on" /> : null}
						<Button type="submit" size="lg" variant={page.isOff ? "outline" : "default"} className="w-full">
							{page.isOff ? "Turn them back on" : "Stop emails about replies"}
						</Button>
					</form>
				</CardNotice>
			)}
		</main>
	);
}

async function findPage(token) {
	const reference = verifyReaderToken("replies", token);
	if (!reference) return null;
	try {
		await connectDb();
		const newsletter = await findOpenNewsletter({ _id: reference.newsletterId });
		const contact = newsletter && (await Contact.findOne({ accountId: newsletter.accountId, newsletterId: newsletter._id, _id: reference.contactId }).select({ community: 1 }).lean());
		return contact ? { newsletter, isOff: Boolean(contact.community?.repliesOff) } : null;
	} catch (error) {
		console.error("[reader] Could not load the reply emails page:", error.message);
		return null;
	}
}
