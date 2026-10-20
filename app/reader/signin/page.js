import { BookOpen, Link2Off, MessageCircle } from "lucide-react";
import CardNotice from "@/components/CardNotice";
import { Button } from "@/components/ui/button";
import { getArchiveUrls } from "@/lib/archive-hosts";
import { connectDb } from "@/lib/db";
import { previewSignInLink } from "@/lib/reader-session";
import { ARCHIVE_SLUG_PATTERN } from "@/lib/slug";
import { continueSignIn } from "@/app/reader/signin/actions";

// The URL carries the sign-in token: keep it out of search results and referrer headers.
export const metadata = {
	title: "Sign in to comment",
	robots: { index: false, follow: false },
	referrer: "no-referrer",
};

export const dynamic = "force-dynamic";

// The page behind the link in the sign-in email. It asks for one click before using the link up.
export default async function ReaderSignInPage({ searchParams }) {
	const { token, p, g } = await searchParams;
	const isGate = g === "1";
	const validToken = typeof token === "string" ? token : "";
	const issueSlug = typeof p === "string" && ARCHIVE_SLUG_PATTERN.test(p) ? p : "";
	const preview = await getPreview(validToken);
	const urls = preview.newsletter && getArchiveUrls(preview.newsletter);

	return (
		<main className="theme-neutral flex min-h-dvh items-center justify-center bg-background px-4 py-16">
			{preview.state === "ready" ? (
				<CardNotice icon={isGate ? BookOpen : MessageCircle} title={`Sign in to ${preview.newsletter.name}`}>
					{isGate ? "One click and the full issue opens. Your email address stays private." : "One click and you can join the discussion. Your email address stays private."}
					<form action={continueSignIn} className="mt-6">
						<input type="hidden" name="token" value={validToken} />
						<input type="hidden" name="p" value={issueSlug} />
						{isGate && <input type="hidden" name="g" value="1" />}
						<Button type="submit" size="lg" className="w-full">
							Continue
						</Button>
					</form>
				</CardNotice>
			) : (
				<CardNotice icon={Link2Off} title={preview.state === "spent" ? "This link was already used" : "This link doesn't work"}>
					{preview.state === "spent"
						? "A sign-in link works once. If you aren't signed in, ask for a new one on the issue's page."
						: "It may have expired: sign-in links last 30 minutes. Ask for a new one on the issue's page."}
					{urls && (
						<Button asChild size="lg" variant="outline" className="mt-6 w-full">
							<a href={`${issueSlug ? urls.absolutePost(issueSlug) : urls.siteIndex}${isGate ? "" : "#comments"}`}>{isGate ? "Back to the issue" : "Back to the discussion"}</a>
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
