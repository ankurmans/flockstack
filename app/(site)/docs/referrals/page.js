import Link from "next/link";
import BlockCode from "@/components/BlockCode";
import HeaderDocs from "@/components/HeaderDocs";
import { getDocsPageMetadata } from "@/lib/docs/llms";
import { MAX_REWARDS, MAX_REWARD_REFERRALS } from "@/lib/referral-rules";
import { REFERRAL_COUNT_TAG, REFERRAL_LINK_TAG, SHARE_BLOCK_HTML } from "@/lib/referral-tags";

export const metadata = getDocsPageMetadata("/docs/referrals");

export default function ReferralsPage() {
	return (
		<>
			<HeaderDocs kicker="Guides" title="Referrals">
				Every subscriber gets a link of their own. When someone signs up through it and confirms their email, it counts for the subscriber
				who shared it, and rewards you set unlock as the count grows.
			</HeaderDocs>

			<Section title="Set it up" stagger={1}>
				<p>
					Turn it on from the{" "}
					<Link href="/referrals" className="font-medium text-link underline decoration-link/30 underline-offset-4 hover:decoration-link">
						Referrals page
					</Link>{" "}
					or with <Code>update_referral_settings</Code>. A newsletter needs confirmation emails on, so a referral only counts once the new
					subscriber has proved their address, and its website on, since the links lead to its signup form. A reward is a title, the number
					of referrals that unlocks it (1 to {MAX_REWARD_REFERRALS.toLocaleString("en-US")}) and a link or a message. Up to {MAX_REWARDS}{" "}
					rewards, each at a different number.
				</p>
			</Section>

			<Section title="What subscribers see" stagger={2}>
				<p>
					The link is the newsletter&apos;s website with the subscriber&apos;s code: <Code>https://your-slug.example.com/?ref=…</Code>. The
					code names the subscriber and is signed, so it can&apos;t be guessed. The visitor can read a few issues before signing up: the
					website keeps the code for 30 days.
				</p>
				<p className="mt-4">
					Each subscriber also has a page of their own, with their link, how many people they brought in, the next reward and the rewards
					they unlocked, which show their link or message. It is signed, so only the subscriber has it, and it never expires. Reaching a
					reward sends the subscriber an email with the same, through the same sending path as the welcome email: it carries the
					unsubscribe link, counts toward the month&apos;s emails, and is skipped for an address on the suppression list or while the
					account is blocked.
				</p>
			</Section>

			<Section title="In your issues" stagger={3}>
				<p>
					Write <Code>{REFERRAL_LINK_TAG}</Code> in an issue for each subscriber&apos;s own link and <Code>{REFERRAL_COUNT_TAG}</Code> for
					their count. In the editor, type / and pick Referral block. On the website, where readers aren&apos;t subscribers, the link goes to
					the signup form and the count is 0. In the RSS feed the link is the website.
				</p>
				<BlockCode title="HTML issues" className="mt-4" code={SHARE_BLOCK_HTML} />
			</Section>

			<Section title="What doesn't count" stagger={4}>
				<p>The new subscriber still joins; the referral just isn&apos;t counted. The Referrals page lists these with the reason.</p>
				<ul className="mt-3 list-disc space-y-1.5 pl-5 marker:text-muted-foreground">
					<li>Someone already on the list, or who signs up again. Only a new subscriber can be referred, once.</li>
					<li>A subscriber referring themselves, by their address or an alias of it (dots and +tags at Gmail, +tags at Outlook, iCloud and others).</li>
					<li>Several aliases of one inbox referred by the same subscriber.</li>
					<li>More than two signups from one network for the same subscriber, counting the subscriber&apos;s own. A household can, a farm can&apos;t.</li>
					<li>Floods: 3 referrals a day from one network, 30 a day for one subscriber.</li>
					<li>An address that bounced, complained or is on the suppression list when it confirms, and a referrer who has left.</li>
				</ul>
			</Section>

			<Section title="From the API" stagger={5}>
				<p>
					<Code>get_referral_settings</Code>, <Code>update_referral_settings</Code>, <Code>list_referrals</Code> and{" "}
					<Code>get_referral_leaderboard</Code> work from the REST API and MCP. A signup form of your own passes the <Code>ref</Code> of the
					address the visitor arrived by as <Code>referral</Code> to <Code>add_contact</Code>.
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
