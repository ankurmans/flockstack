import { getReaderText } from "@/lib/reader-languages";
import { BookOpen, Link2Off, MessageCircle, UserRound } from "lucide-react";
import { redirect } from "next/navigation";
import CardNotice from "@/components/CardNotice";
import { Button } from "@/components/ui/button";
import { getArchiveUrls } from "@/lib/archive-hosts";
import { connectDb } from "@/lib/db";
import { SIGNIN_DESTINATIONS } from "@/lib/reader-links";
import { getMountHandoffUrl, previewSignInLink } from "@/lib/reader-session";
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
	const handoff = await getHandoff(validToken, issueSlug, destination);
	if (handoff) redirect(handoff);
	const preview = await getPreview(validToken);
	const urls = preview.newsletter && getArchiveUrls(preview.newsletter);

	const t = getReaderText(preview.newsletter);

	return (
		<main lang={t.language} className="theme-neutral flex min-h-dvh items-center justify-center bg-background px-4 py-16">
			{preview.state === "ready" ? (
				<CardNotice icon={destination === "issue" ? BookOpen : isAccount ? UserRound : MessageCircle} title={t("Sign in to {name}", { name: preview.newsletter.name })}>
					{destination === "issue"
						? t("One click and the full issue opens. Your email address stays private.")
						: isAccount
							? t("One click and you are in: your subscription, your preferences and your referrals are all on your account page.")
							: t("One click and you can join the discussion. Your email address stays private.")}
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
				<CardNotice icon={Link2Off} title={preview.state === "spent" ? t("This link was already used") : "This link doesn't work"}>
					{preview.state === "spent"
						? `A sign-in link works once. If you aren't signed in, ask for a new one ${isAccount ? t("on the sign-in page") : t("on the issue's page")}.`
						: `It may have expired: sign-in links last 30 minutes. Ask for a new one ${isAccount ? t("on the sign-in page") : t("on the issue's page")}.`}
					{urls && (
						<Button asChild size="lg" variant="outline" className="mt-6 w-full">
							{isAccount ? (
								<a href={urls.absoluteSignin}>{t("Get a new link")}</a>
							) : destination === "issue" ? (
								<a href={issueSlug ? urls.absolutePost(issueSlug) : urls.siteIndex}>{t("Back to the issue")}</a>
							) : (
								<a href={`${issueSlug ? urls.absolutePost(issueSlug) : urls.siteIndex}#comments`}>{t("Back to the discussion")}</a>
							)}
						</Button>
					)}
				</CardNotice>
			)}
		</main>
	);
}

// The same page under the newsletter's subfolder, where the session it starts is read (lib/reader-session.js).
async function getHandoff(token, issueSlug, destination) {
	if (!token) return null;
	try {
		await connectDb();
		const query = new URLSearchParams({ token, ...(issueSlug && { p: issueSlug }), ...(destination && { next: destination }) });
		return await getMountHandoffUrl("signin", token, "/reader/signin", `?${query}`);
	} catch (error) {
		console.error("[reader] Could not check the sign-in link:", error.message);
		return null;
	}
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
