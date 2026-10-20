import { BookOpen, Link2Off, MessageCircle, UserRound } from "lucide-react";
import CardNotice from "@/components/CardNotice";
import { Button } from "@/components/ui/button";
import { getArchiveUrls } from "@/lib/archive-hosts";
import { connectDb } from "@/lib/db";
import { SIGNIN_DESTINATIONS } from "@/lib/reader-links";
import { previewSignInLink } from "@/lib/reader-session";
import { ARCHIVE_SLUG_PATTERN } from "@/lib/slug";
import { continueSignIn } from "@/app/reader/signin/actions";

// The URL carries the sign-in token: keep it out of search results and referrer headers.
export const metadata = {
	title: "Sign in",
	robots: { index: false, follow: false },
	referrer: "no-referrer",
};

export const dynamic = "force-dynamic";

// The page behind the link in the sign-in email. It asks for one click before using the link up.
export default async function ReaderSignInPage({ searchParams }) {
	const { token, p, next } = await searchParams;
	const validToken = typeof token === "string" ? token : "";
	const issueSlug = typeof p === "string" && ARCHIVE_SLUG_PATTERN.test(p) ? p : "";
	const destination = SIGNIN_DESTINATIONS.includes(next) ? next : "";
	const isAccount = destination === "account";
	const preview = await getPreview(validToken);
	const urls = preview.newsletter && getArchiveUrls(preview.newsletter);

	return (
		<main className="theme-neutral flex min-h-dvh items-center justify-center bg-background px-4 py-16">
			{preview.state === "ready" ? (
				<CardNotice icon={destination === "issue" ? BookOpen : isAccount ? UserRound : MessageCircle} title={`Sign in to ${preview.newsletter.name}`}>
					{destination === "issue"
						? "One click and the full issue opens. Your email address stays private."
						: isAccount
							? "One click and you are in: your subscription, your preferences and your referrals are all on your account page."
							: "One click and you can join the discussion. Your email address stays private."}
					<form action={continueSignIn} className="mt-6">
						<input type="hidden" name="token" value={validToken} />
						<input type="hidden" name="p" value={issueSlug} />
						<input type="hidden" name="next" value={destination} />
						<Button type="submit" size="lg" className="w-full">
							Continue
						</Button>
					</form>
				</CardNotice>
			) : (
				<CardNotice icon={Link2Off} title={preview.state === "spent" ? "This link was already used" : "This link doesn't work"}>
					{preview.state === "spent"
						? `A sign-in link works once. If you aren't signed in, ask for a new one ${isAccount ? "on the sign-in page" : "on the issue's page"}.`
						: `It may have expired: sign-in links last 30 minutes. Ask for a new one ${isAccount ? "on the sign-in page" : "on the issue's page"}.`}
					{urls && (
						<Button asChild size="lg" variant="outline" className="mt-6 w-full">
							{isAccount ? (
								<a href={urls.absoluteSignin}>Get a new link</a>
							) : destination === "issue" ? (
								<a href={issueSlug ? urls.absolutePost(issueSlug) : urls.siteIndex}>Back to the issue</a>
							) : (
								<a href={`${issueSlug ? urls.absolutePost(issueSlug) : urls.siteIndex}#comments`}>Back to the discussion</a>
							)}
						</Button>
					)}
				</CardNotice>
			)}
		</main>
	);
}

async function getPreview(token) {
	try {
		await connectDb();
		return await previewSignInLink(token);
	} catch (error) {
		console.error("[reader] Could not check the sign-in link:", error.message);
		return { state: "invalid" };
	}
}
