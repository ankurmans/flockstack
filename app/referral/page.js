import { Gift, Link2Off, Lock } from "lucide-react";
import AvatarNewsletter from "@/components/AvatarNewsletter";
import ButtonCopy from "@/components/ButtonCopy";
import CardNotice from "@/components/CardNotice";
import LinksShare from "@/components/LinksShare";
import { connectDb } from "@/lib/db";
import { formatCount } from "@/lib/format";
import { findOpenNewsletter } from "@/lib/public-newsletters";
import { verifyReferralPageToken } from "@/lib/referral-links";
import { getReferralStatus } from "@/lib/referrals";
import Contact from "@/models/Contact";

// The URL carries the token that opens one subscriber's page: keep it out of search results and referrer headers.
export const metadata = {
	title: "Your referrals",
	robots: { index: false, follow: false },
	referrer: "no-referrer",
};

// A subscriber's own page, from the link in their emails: their referral link, how many people it brought in and the
// rewards, which show their link or message once they have unlocked them.
export default async function ReferralPage({ searchParams }) {
	const { token } = await searchParams;
	const reference = verifyReferralPageToken(typeof token === "string" ? token : null);
	const page = reference ? await findPage(reference) : null;

	return (
		<main className="flex min-h-dvh items-start justify-center bg-background px-4 py-12 sm:items-center sm:py-16">
			{!page ? (
				<CardNotice icon={Link2Off} title="This link doesn't work">
					It may be mistyped. Open the link in the newest email you got from the newsletter.
				</CardNotice>
			) : !page.status.isActive || page.contact.status !== "active" ? (
				<CardNotice icon={Gift} title="Referrals are off">
					{page.newsletter.name} isn&apos;t counting referrals right now.
				</CardNotice>
			) : (
				<Referrals newsletter={page.newsletter} status={page.status} />
			)}
		</main>
	);
}

async function findPage({ contactId, newsletterId }) {
	try {
		await connectDb();
		const newsletter = await findOpenNewsletter({ _id: newsletterId });
		const contact = newsletter && (await Contact.findOne({ accountId: newsletter.accountId, _id: contactId, newsletterId }).lean());
		return contact ? { newsletter, contact, status: getReferralStatus({ newsletter, contact }) } : null;
	} catch (error) {
		console.error("[referral] Could not load the page:", error.message);
		return null;
	}
}

function Referrals({ newsletter, status }) {
	const { count, link, next, rewards } = status;
	const progress = next ? Math.min(100, Math.round((count / next.referrals) * 100)) : 100;

	return (
		<div className="flex w-full max-w-md flex-col gap-4 animate-enter">
			<div className="rounded-xl bg-card p-6 shadow-border sm:p-8">
				<div className="flex items-center gap-3">
					<AvatarNewsletter newsletter={newsletter} size={36} className="rounded-lg" />
					<h1 className="text-lg font-semibold tracking-tight text-balance">Share {newsletter.name}</h1>
				</div>
				<p className="mt-4 text-sm text-pretty text-muted-foreground">
					Send your link to someone who&apos;d like it. When they sign up and confirm, it counts for you, and you unlock the rewards below.
				</p>
				<div className="mt-4 flex items-center gap-1 rounded-lg bg-muted/60 py-1 pr-1 pl-3">
					<input
						readOnly
						value={link}
						aria-label="Your referral link"
						onFocus={undefined}
						className="min-w-0 flex-1 bg-transparent font-mono text-[13px] outline-none"
					/>
					<ButtonCopy value={link} label="Copy your referral link" />
				</div>
				<LinksShare url={link} text={`${newsletter.name}: worth subscribing to.`} className="mt-2 -ml-2.5" />
			</div>

			<div className="rounded-xl bg-card p-6 shadow-border sm:p-8">
				<p className="text-3xl font-semibold tabular-nums">{count}</p>
				<p className="text-sm text-muted-foreground">{count === 1 ? "person has" : "people have"} signed up and confirmed through your link</p>
				<div className="mt-4 h-2 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}>
					<div className="h-full rounded-full bg-foreground transition-[width] duration-300" style={{ width: `${progress}%` }} />
				</div>
				<p className="mt-2 text-sm text-pretty text-muted-foreground">
					{next ? `${formatCount(next.remaining, "more referral")} unlocks ${next.title}.` : rewards.length > 0 ? "You've unlocked every reward." : "Thank you for sharing."}
				</p>
			</div>

			{rewards.length > 0 && (
				<ul className="flex flex-col gap-2">
					{rewards.map((reward) => (
						<li key={reward.id} className="rounded-xl bg-card p-4 shadow-border">
							<div className="flex items-start justify-between gap-3">
								<p className="font-medium text-pretty">{reward.title}</p>
								<span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground tabular-nums">
									{!reward.isUnlocked && <Lock className="size-3" aria-hidden="true" />}
									{formatCount(reward.referrals, "referral")}
								</span>
							</div>
							{reward.isUnlocked ? (
								<div className="mt-2 flex flex-col gap-2 text-sm text-pretty">
									{reward.text && <p className="whitespace-pre-line text-foreground/80">{reward.text}</p>}
									{reward.url && (
										<a href={reward.url} rel="noopener noreferrer" className="w-fit font-medium underline underline-offset-4">
											Get your reward
										</a>
									)}
								</div>
							) : (
								<p className="mt-1 text-sm text-muted-foreground">Locked until you reach {formatCount(reward.referrals, "referral")}.</p>
							)}
						</li>
					))}
				</ul>
			)}
		</div>
	);
}
