import Link from "next/link";
import BlockCode from "@/components/BlockCode";
import HeaderDocs from "@/components/HeaderDocs";
import { getDocsPageMetadata } from "@/lib/docs/pages";
import { MAX_PITCH_LENGTH, MAX_RECOMMENDATIONS, REGION_RULE } from "@/lib/recommendation-rules";
import { RECOMMENDATIONS_TAG } from "@/lib/recommendation-tags";

export const metadata = getDocsPageMetadata("/docs/recommendations");

export default function RecommendationsPage() {
	return (
		<>
			<HeaderDocs kicker="Guides" title="Recommendations">
				A newsletter can recommend up to {MAX_RECOMMENDATIONS} others to its readers, each with a pitch in its own words. It is free: no paid
				placement and no cut of anyone&apos;s revenue. A reader&apos;s email reaches another newsletter only when that reader ticks it.
			</HeaderDocs>

			<Section title="Recommend a newsletter" stagger={1}>
				<p>
					Add one from the{" "}
					<Link href="/recommending" className="font-medium text-link underline decoration-link/30 underline-offset-4 hover:decoration-link">
						Recommendations page
					</Link>{" "}
					or with <Code>add_recommendation</Code>: the other newsletter&apos;s slug and a pitch of up to {MAX_PITCH_LENGTH} characters, plain
					text without links. Find newsletters that want to be found in the{" "}
					<Link href="/recommendations" className="font-medium text-link underline decoration-link/30 underline-offset-4 hover:decoration-link">
						directory
					</Link>{" "}
					or with <Code>search_recommendable_newsletters</Code>.
				</p>
				<p className="mt-4">It is refused, with the reason, when the other newsletter:</p>
				<ul className="mt-3 list-disc space-y-1.5 pl-5 marker:text-muted-foreground">
					<li>is in your own account. Recommendations are between different accounts, so they can&apos;t be used to grow a list in a loop;</li>
					<li>turned off incoming recommendations;</li>
					<li>doesn&apos;t ask new subscribers to confirm their email;</li>
					<li>has its website off, or hasn&apos;t sent its first issue, so readers would have no page to sign up on;</li>
					<li>can&apos;t take subscribers right now, because its account is blocked or waiting to be deleted;</li>
					<li>sends from an address that isn&apos;t verified yet, so it couldn&apos;t send the confirmation email.</li>
				</ul>
				<p className="mt-4">
					If one of these becomes true later, the recommendation turns pending, with the reason on both newsletters&apos; pages. It stops
					showing and comes back by itself when the reason is gone.
				</p>
			</Section>

			<Section title="Where readers see them" stagger={2}>
				<p>
					<strong className="font-medium text-foreground">After they subscribe.</strong> Once a reader has subscribed, or has confirmed
					their address when the newsletter confirms signups, a &ldquo;You might also like&rdquo; step lists the recommended newsletters with
					their pitches. Nothing is ticked. The reader ticks the ones they want and presses Subscribe, and each one starts a normal signup
					to that newsletter: its own confirmation email, its own rules, nothing else. The reader&apos;s address is used only for the
					newsletters they ticked, and only with the signed proof of the signup that just happened.
				</p>
				<p className="mt-4">
					<strong className="font-medium text-foreground">On the website.</strong> A &ldquo;Recommended newsletters&rdquo; section on the
					newsletter&apos;s home page and under each issue, with links to the other newsletters&apos; own signup pages.
				</p>
				<p className="mt-4">
					<strong className="font-medium text-foreground">In issues.</strong> Write <Code>{RECOMMENDATIONS_TAG}</Code> where the block
					goes. It prints the list with links, in the email, the web version and the RSS feed, and nothing in it is pre-ticked. Without any
					recommendation showing, the tag prints nothing.
				</p>
				<BlockCode title="In an issue" className="mt-4" code={`Thanks for reading.\n\n${RECOMMENDATIONS_TAG}`} />
			</Section>

			<Section title="Being recommended" stagger={3}>
				<p>
					A newsletter takes recommendations unless its owner turns it off with <Code>set_recommendation_settings</Code> or on the
					Recommendations page. Its owner sees who recommends it, the pitch they wrote and how many subscribers it brought, and can decline a
					single recommendation with a reason, or bring it back. Turning incoming recommendations off applies at once. The recommender always
					sees the reason on their page: a removal never happens silently.
				</p>
				<p className="mt-4">
					Listing in the directory is a separate switch, off by default. A listed newsletter shows its name, description, website and a
					range of subscribers such as &ldquo;1,000 to 5,000&rdquo;, never an exact number. Only newsletters whose website is public and
					that can take a signup are listed.
				</p>
			</Section>

			<Section title="What it counts" stagger={4}>
				<p>
					Each recommendation counts how many times a page showed it (once per visitor and day, with no personal data kept), how many new
					contacts it brought to the other newsletter and how many of them confirmed. The contact&apos;s source is{" "}
					<Code>recommendation:your-slug</Code>, so segments and the contacts list can filter by it. Someone who was already on the other
					newsletter&apos;s list isn&apos;t counted.
				</p>
				<p className="mt-4">
					Limits keep it honest: {MAX_RECOMMENDATIONS} recommendations per newsletter, 30 additions a day per account, 300 signups a day
					through one newsletter&apos;s recommendation of another, and a cap per network on the signup step.
				</p>
			</Section>

			<Section title="Regions" stagger={5}>
				<p>
					{REGION_RULE} A slug from the other region isn&apos;t found, and the directory lists only this region&apos;s newsletters.
				</p>
			</Section>

			<Section title="From the API" stagger={6}>
				<p>
					<Code>list_recommendations</Code>, <Code>add_recommendation</Code>, <Code>update_recommendation</Code>,{" "}
					<Code>remove_recommendation</Code>, <Code>get_recommendation_stats</Code>, <Code>set_recommendation_settings</Code> and{" "}
					<Code>search_recommendable_newsletters</Code> work from the REST API and MCP, with the same checks as the dashboard.
				</p>
			</Section>
		</>
	);
}

function Section({ title, stagger, children }) {
	return (
		<section style={{ "--stagger": stagger }} className="mt-12 max-w-3xl animate-enter first-of-type:mt-0">
			<h2 className="mb-3 text-xl font-semibold tracking-tight">{title}</h2>
			<div className="text-[15px] leading-7 text-pretty text-foreground/80">{children}</div>
		</section>
	);
}

function Code({ children }) {
	return <code className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[13px] text-foreground">{children}</code>;
}
