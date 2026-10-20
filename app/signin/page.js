import { Suspense } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowRight } from "lucide-react";
import ButtonSigninApple from "@/components/ButtonSigninApple";
import ButtonSigninGoogle from "@/components/ButtonSigninGoogle";
import ButtonSigninPasskey from "@/components/ButtonSigninPasskey";
import FormSignin from "@/components/FormSignin";
import LayoutSplit from "@/components/LayoutSplit";
import LogoWordmark from "@/components/LogoWordmark";
import RegionPicker from "@/components/RegionPicker";
import { FooterCookies, SigninAside, SiteAnalytics, SupportChat } from "@/components/SiteExtensions";
import { Button } from "@/components/ui/button";
import { getSession, getSignupError, isAppleEnabled, isGoogleEnabled } from "@/lib/auth";
import { isCloud } from "@/lib/config";
import { getPublishedLegalPages } from "@/lib/legal";
import { readOAuthRequest } from "@/lib/oauth";
import { REGION_PLACES, getOtherRegion, getRegion, getRegionOptions, getSigninUrl } from "@/lib/region";
import { readRegionChoice } from "@/lib/region-choice";
import { DELETION_GRACE_DAYS } from "@/lib/retention";
import { toSafeNextPath } from "@/lib/validation";

export const metadata = { title: "Sign in" };

// Also where an app connecting with OAuth (ChatGPT, Claude) sends people who aren't signed in: Better Auth
// adds the signed authorization request to the query, and signing in carries on to the consent page.
export default async function SigninPage({ searchParams }) {
	const params = await searchParams;
	const { next, error, deleted } = params;
	const nextPath = toSafeNextPath(next);
	const oauthRequest = await readOAuthRequest(params);
	if (!oauthRequest && (await getSession())) redirect(nextPath);
	const oauthQuery = oauthRequest && !oauthRequest.isExpired ? oauthRequest.query : null;
	const intro = getIntro(oauthRequest, deleted !== undefined);
	// FlockStack Cloud has one Worker per region. An app connecting with OAuth chose its region with the server's address.
	const regions = isCloud() && !oauthRequest ? await getRegions(params.region, nextPath) : null;

	return (
		<LayoutSplit aside={SigninAside && <SigninAside />}>
			<header className="flex h-9 items-center">
				<LogoWordmark href="/" className="rounded-md" />
			</header>
			<div className="flex flex-1 items-center justify-center py-12">
				<div className="w-full max-w-[22rem] animate-enter">
					<h1 className="font-display text-[2.5rem] leading-[1.05] font-[480] tracking-[-0.03em] text-balance">Sign in to FlockStack</h1>
					{intro && <p className="mt-3 text-[15px] leading-6 text-pretty text-muted-foreground">{intro}</p>}
					{regions && <RegionPicker {...regions.picker} className="mt-8" />}
					{oauthRequest?.isExpired ? null : regions?.isElsewhere ? (
						<div className="mt-6 flex flex-col gap-3">
							<p className="text-sm text-pretty text-muted-foreground">Your account and everything in it will be stored in {regions.place}.</p>
							<Button asChild size="lg" className="h-11">
								<a href={regions.href}>
									Continue in {regions.place}
									<ArrowRight data-icon="inline-end" />
								</a>
							</Button>
						</div>
					) : (
						<div className={regions ? "mt-6" : "mt-8"}>
							{(isGoogleEnabled() || isAppleEnabled()) && (
								<>
									<div className="flex flex-col gap-3">
										{isGoogleEnabled() && <ButtonSigninGoogle next={nextPath} oauthQuery={oauthQuery} />}
										{isAppleEnabled() && <ButtonSigninApple next={nextPath} oauthQuery={oauthQuery} />}
									</div>
									<div className="my-5 flex items-center gap-3 text-xs text-muted-foreground">
										<span className="h-px flex-1 bg-border" />
										or
										<span className="h-px flex-1 bg-border" />
									</div>
								</>
							)}
							{typeof error === "string" && (
								<p role="alert" className="mb-3 text-sm text-pretty text-destructive">
									{getSignupError(error) ?? "Sign-in failed. Try again."}
								</p>
							)}
							<FormSignin next={nextPath} oauthQuery={oauthQuery} />
							{!oauthQuery && (
								<div className="mt-5">
									<ButtonSigninPasskey next={nextPath} />
								</div>
							)}
						</div>
					)}
					{regions && (
						<p className="mt-6 text-sm text-pretty text-muted-foreground">
							Already have an account in the other region?{" "}
							<a href={regions.otherHref} className="font-medium whitespace-nowrap text-link underline decoration-link/30 underline-offset-4 hover:decoration-link">
								Sign in there.
							</a>
						</p>
					)}
					{isCloud() && <LegalNotice />}
				</div>
			</div>
			{SupportChat && (
				<Suspense fallback={null}>
					<SupportChat />
				</Suspense>
			)}
			{SiteAnalytics && <SiteAnalytics />}
		</LayoutSplit>
	);
}

const LINK_CLASS = "underline decoration-foreground/30 underline-offset-4 hover:text-foreground hover:decoration-foreground";

// A code creates an account at its first sign-in, so this is also the sign-up step. Until the legal pages are published
// (lib/legal.js) there is nothing to agree to, and only Cookie settings is left.
function LegalNotice() {
	const pages = getPublishedLegalPages();
	if (pages.length === 0 && !FooterCookies) return null;
	return (
		<div className="mt-8 flex flex-col gap-3 text-xs text-pretty text-muted-foreground">
			{pages.length > 0 && (
				<p>
					By continuing you agree to the{" "}
					<Link href="/terms" className={LINK_CLASS}>
						Terms
					</Link>{" "}
					and{" "}
					<Link href="/privacy" className={LINK_CLASS}>
						Privacy Policy
					</Link>
					.
				</p>
			)}
			<nav aria-label="Legal">
				<ul className="flex flex-wrap gap-x-4 gap-y-1">
					{pages.map(({ href, label }) => (
						<li key={href}>
							<Link href={href} className={LINK_CLASS}>
								{label}
							</Link>
						</li>
					))}
					{FooterCookies && <FooterCookies className={LINK_CLASS} />}
				</ul>
			</nav>
		</div>
	);
}

// The picker's props, and whether the choice is the other region's, which has its own sign-in page: an account lives in
// exactly one region, so there is no way to look it up from here.
async function getRegions(queryRegion, next) {
	const choice = await readRegionChoice(typeof queryRegion === "string" ? queryRegion : undefined);
	const current = getRegion();
	return {
		picker: { options: getRegionOptions({ next }), selected: choice.region, current, remember: choice.source === "query" && choice.region === current },
		isElsewhere: choice.region !== current,
		place: REGION_PLACES[choice.region],
		href: getSigninUrl(choice.region, { next }),
		otherHref: getSigninUrl(getOtherRegion(current), { next }),
	};
}

// Only what changes what to do: an app connecting, an expired link, an account just deleted, or a server that lets
// few emails in.
function getIntro(oauthRequest, isDeleted) {
	if (oauthRequest?.isExpired) return "This sign-in link expired. Go back to the app and connect FlockStack again.";
	if (oauthRequest) return `${oauthRequest.client.name} wants to connect to your FlockStack account. Sign in first.`;
	if (isDeleted) return `Your account is deleted. Sign in within ${DELETION_GRACE_DAYS} days to restore it.`;
	if (!isCloud()) return "Only the emails this server allows can sign in.";
	return null;
}
