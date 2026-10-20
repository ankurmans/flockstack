import { notFound } from "next/navigation";
import { Check } from "lucide-react";
import FormCustomRequest from "@/components/FormCustomRequest";
import HeaderDocs from "@/components/HeaderDocs";
import LinkInline from "@/components/LinkInline";
import { isCloud } from "@/lib/config";
import { CUSTOM_PATH, CUSTOM_RETENTION_YEARS } from "@/lib/custom-choices";
import { CUSTOM_NOT_YET, getCustomPlan } from "@/lib/custom-tier";
import { PRIVACY_EMAIL, getPublishedLegalPages } from "@/lib/legal";
import { getPageMetadata } from "@/lib/site";

export const metadata = getPageMetadata({
	title: "Custom plan",
	description: `For lists with ${getCustomPlan().subscribers.toLowerCase()} subscribers or ${getCustomPlan().emails.toLowerCase()} emails a month: tell us what you send and what you would need, and we reply personally.`,
	path: CUSTOM_PATH,
});

// Open to anyone, signed in or not, in both regions: a request is stored where it is sent. FlockStack Cloud only.
export default function CustomPage() {
	if (!isCloud()) notFound();
	const plan = getCustomPlan();
	const hasPrivacy = getPublishedLegalPages().some(({ href }) => href === "/privacy");

	return (
		<main className="mx-auto max-w-3xl px-4 py-12 sm:px-6 sm:py-16">
			<HeaderDocs kicker="Custom plan" title="Tell us what you need">
				For lists with {plan.subscribers.toLowerCase()} subscribers or {plan.emails.toLowerCase()} emails a month there is no plan to pick. Tell us what
				you send and what you would need, and a person on the FlockStack team replies. {plan.reply}
			</HeaderDocs>

			<section aria-labelledby="custom-today" className="mb-10">
				<h2 id="custom-today" className="text-lg font-semibold tracking-tight">
					What a Custom plan is today
				</h2>
				<ul className="mt-4 flex flex-col gap-2.5 text-[15px]">
					{plan.bullets.map((bullet) => (
						<li key={bullet} className="flex items-start gap-2.5">
							<Check className="mt-1 size-4 shrink-0 text-muted-foreground" strokeWidth={2.5} aria-hidden="true" />
							{bullet}
						</li>
					))}
				</ul>
			</section>

			<section aria-labelledby="custom-not-yet" className="mb-12 rounded-2xl bg-muted/50 p-6">
				<h2 id="custom-not-yet" className="text-lg font-semibold tracking-tight">
					What FlockStack doesn&apos;t have yet
				</h2>
				<p data-not-yet className="mt-2 text-[15px] leading-7 text-pretty text-foreground/80">
					{CUSTOM_NOT_YET}
				</p>
			</section>

			<FormCustomRequest />

			<p className="mt-10 text-sm leading-6 text-pretty text-muted-foreground">
				We use what you write here to reply to you and to decide what to build, and for nothing else. We keep it while we talk and for{" "}
				{CUSTOM_RETENTION_YEARS} years after, and delete it whenever you ask: write to{" "}
				<LinkInline href={`mailto:${PRIVACY_EMAIL}`}>{PRIVACY_EMAIL}</LinkInline>.
				{hasPrivacy && (
					<>
						{" "}
						The <LinkInline href="/privacy">privacy policy</LinkInline> has the rest.
					</>
				)}
			</p>
		</main>
	);
}
