import Link from "next/link";
import BlockCode from "@/components/BlockCode";
import HeaderDocs from "@/components/HeaderDocs";
import { API_BASE_PATH } from "@/lib/api/rest";
import { getAppUrl } from "@/lib/config";
import { getDocsPageMetadata } from "@/lib/docs/llms";
import { DOWNLOAD_LINK_DAYS, MAX_DOWNLOADS_PER_ORDER } from "@/lib/download-link";
import { MAX_PRODUCT_FILE_BYTES } from "@/lib/products";

export const metadata = getDocsPageMetadata("/docs/selling");

const EVENTS = [
	"checkout.session.completed",
	"checkout.session.async_payment_succeeded",
	"charge.refunded",
	"charge.dispute.created",
	"customer.subscription.created",
	"customer.subscription.updated",
	"customer.subscription.deleted",
	"invoice.paid",
	"invoice.payment_failed",
	"account.updated",
	"account.application.deauthorized",
];

export default function SellingPage() {
	const appUrl = getAppUrl();

	return (
		<>
			<HeaderDocs kicker="Guides" title="Selling" product={{ href: "/paid-newsletter-platform", label: "Paid newsletters on FlockStack" }}>
				Sell digital products and paid subscriptions to your readers, from the dashboard, the REST API or an AI assistant. Readers pay your
				own Stripe account. FlockStack takes no cut: only Stripe&apos;s processing fee comes off a sale. Selling works on every plan, the Free plan included.
			</HeaderDocs>

			<Section title="Set up payments" stagger={1}>
				<p>
					On FlockStack Cloud, each account connects its own Stripe account from the{" "}
					<Link href="/payments" className="text-link underline decoration-link/30 underline-offset-4 hover:decoration-link">
						Payments page
					</Link>{" "}
					(<Code>connect_payments</Code>): Stripe&apos;s page takes you through its details, and the account stays yours, with its own
					dashboard for payouts, refunds and disputes. <Code>get_payments_status</Code> says when it can take charges. On a self-hosted
					server, set <Code>STRIPE_SECRET_KEY</Code> and sales go to that Stripe account.
				</p>
				<p className="mt-4">
					Stripe sends what happens to sales to <Code>{appUrl}/api/webhooks/payments</Code>. Add that endpoint in Stripe with the events
					below and put its signing secret in <Code>STRIPE_PAYMENTS_WEBHOOK_SECRET</Code>. On FlockStack Cloud, choose to listen to events
					on connected accounts.
				</p>
				<ul className="mt-4 grid gap-1 font-mono text-[13px] text-muted-foreground sm:grid-cols-2">
					{EVENTS.map((event) => (
						<li key={event}>{event}</li>
					))}
				</ul>
			</Section>

			<Section title="Digital products" stagger={2}>
				<p>
					<Code>create_product</Code> makes a draft, <Code>set_product_file</Code> stores its file (up to {MAX_PRODUCT_FILE_BYTES / 1024 / 1024}{" "}
					MB), and <Code>update_product</Code> with status <Code>active</Code> puts it on sale at <Code>/shop/&lt;slug&gt;</Code> on the
					newsletter&apos;s site. The reader pays with Stripe Checkout; when Stripe confirms the payment, FlockStack makes the order and
					emails them a download link from the newsletter&apos;s address.
				</p>
				<p className="mt-4">
					The file lives in a private bucket and is never served from a public address. The link is signed, works for {DOWNLOAD_LINK_DAYS}{" "}
					days and {MAX_DOWNLOADS_PER_ORDER} downloads, and stops when the order is refunded in full or disputed. <Code>resend_order_email</Code>{" "}
					sends a new link and ends the old one. A buyer can tick a box to join the newsletter&apos;s list; the newsletter&apos;s own signup
					rules, a confirmation email included, apply.
				</p>
				<BlockCode
					title="Terminal"
					className="mt-4"
					code={`curl ${appUrl}${API_BASE_PATH}/products \\\n  -H "Authorization: Bearer $FLOCKSTACK_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '{"title":"Launch checklist","priceCents":1900}'`}
				/>
			</Section>

			<Section title="Paid subscriptions" stagger={3}>
				<p>
					<Code>set_paid_tier</Code> turns a newsletter&apos;s paid tiers on with a currency, an optional free trial and a pitch; readers
					subscribe on its <Code>/subscribe</Code> page. Stripe tells FlockStack when a subscription starts, renews, is cancelled or fails to
					pay, and each contact is <Code>paid</Code> or <Code>free</Code> accordingly, with <Code>paidUntil</Code> as the end of the period
					they paid for. A failed renewal makes the reader free at once; the next successful payment brings them back.
				</p>
				<p className="mt-4">
					A campaign has an <Code>audience</Code>: <Code>all</Code>, <Code>free</Code> or <Code>paid</Code>. A paid issue goes to paid
					readers only, shows a teaser on its web page and has the whole text in the email. Everything that protects a send applies to it
					as to any other: plan limits, pacing, the list cleanup (a paid reader is never set aside) and the suppression lists. Paid readers
					get a manage-subscription link in every email, which opens their Stripe billing page.
				</p>
			</Section>

			<Section title="Paid tiers" stagger={4}>
				<p>
					A newsletter has up to 3 paid tiers, lowest first (<Code>list_paid_tiers</Code>, <Code>create_paid_tier</Code>,{" "}
					<Code>update_paid_tier</Code>, <Code>delete_paid_tier</Code>, <Code>reorder_paid_tiers</Code>). Each has a name, a description,
					benefits and the prices it asks: monthly, quarterly (every 3 months), yearly, lifetime (one payment that never renews) and pay what
					you want (the reader names the price, above a minimum). Once the paid tier is open, FlockStack makes each tier a Product on your
					Stripe account with a Price per way to pay, so your Stripe dashboard and invoices show real products. A price can&apos;t change in
					Stripe: a new amount makes a new Price, and readers already subscribed keep the one they signed up on.
				</p>
				<p className="mt-4">
					Tier order is the order of importance. A paid issue can go to every paid tier, or to one tier <em>and the tiers above it</em>{" "}
					(<Code>paidTier</Code> on <Code>create_campaign</Code> and <Code>update_campaign</Code>). A segment can filter on a reader&apos;s
					tier, and <Code>subscriber.upgraded</Code> and <Code>subscriber.downgraded</Code> webhooks carry the tier. A tier that readers hold
					can&apos;t be deleted: archive it, and it leaves the subscribe page while its readers keep it.
				</p>
				<p className="mt-4">
					A newsletter that had a paid tier before tiers keeps it: one tier named Paid subscription with its monthly and yearly prices,
					and its readers hold it. It is written out as the lowest tier the first time you add another.
				</p>
			</Section>

			<Section title="Founding members" stagger={5}>
				<p>
					A tier with <Code>founding.enabled</Code> is a founding or supporter tier: the same issues as any paid tier, for more money, shown
					on the subscribe page as a way to back the writer. <Code>founding.cap</Code> limits how many members it takes; when it is full the
					tier leaves the page and checkout refuses more. The cap is checked as a reader starts paying, so two readers finishing at once can
					take it a member past its cap.
				</p>
				<p className="mt-4">
					<Code>set_paid_tier</Code> with <Code>supportersPublic</Code> shows a supporters list on the subscribe page. It is off by default.
					Checkout then asks a founding member for a name to list, which is optional; the page shows names only, never emails.{" "}
					<Code>list_supporters</Code> shows the writer who is listed, and <Code>set_supporter_name</Code> changes a name or takes it off.
				</p>
			</Section>

			<Section title="Pledges" stagger={6}>
				<p>
					A writer who hasn&apos;t opened the paid tier can turn on pledges (<Code>set_pledges</Code>). A reader picks a tier and a monthly or
					yearly price on the subscribe page and enters a card, which is saved on your Stripe account with a SetupIntent and <em>not charged</em>.
					The page says so, the reader gets an email saying the same with a link to cancel, and they stay on the free list. A pledger has no paid
					access until they are charged. <Code>get_pledge_report</Code> counts the pledges and totals them per tier.
				</p>
				<p className="mt-4">
					<Code>start_pledge_charging</Code> needs the paid tier on. It emails every pledger the day of their first charge, <Code>noticeDays</Code>{" "}
					ahead (7 by default, 1 to 30), with a link that cancels the pledge with one click. On that day each card is charged off-session by
					creating a subscription on your Stripe account, at the price they pledged unless <Code>honorPledgedPrice</Code> is false. A pledger who
					canceled is not charged; a refused card is marked failed and the pledger is told; a pledger whose notice couldn&apos;t be emailed is not
					charged. The work runs in QStash steps that save their place: a step that fails is retried from where it stopped, a subscription is made
					once per pledge, and starting again after a failure carries on with the same run. <Code>stop_pledge_charging</Code> stops it until the
					charge day; <Code>get_pledge_charging</Code> shows where it is.
				</p>
			</Section>

			<Section title="Offers and trials" stagger={7}>
				<p>
					<Code>create_offer</Code> makes a discount (<Code>percent</Code> or <Code>amount</Code> off, <Code>once</Code>, <Code>repeating</Code> for
					some months or <Code>forever</Code>, with <Code>maxRedemptions</Code> and <Code>expiresAt</Code>) as a coupon on your Stripe account, or a free
					trial (<Code>trial</Code>, or <Code>trialDays</Code> on a discount). A coupon&apos;s terms can&apos;t change in Stripe, so an
					offer&apos;s can&apos;t either: make another. Every offer has a link, <Code>/offer/&lt;code&gt;</Code> on the newsletter&apos;s site, that
					shows the discounted price and applies the coupon at checkout. A trial can ask for no card until it ends (<Code>trialNoCard</Code>, or
					the same switch on <Code>set_paid_tier</Code> for every trial): Stripe then asks for a card when the trial is over, and a reader who
					doesn&apos;t add one is dropped.
				</p>
				<p className="mt-4">
					<Code>list_offers</Code> and <Code>get_offer</Code> report each offer: how many readers signed up through it, how many of them pay now,
					and who. <Code>set_launch_banner</Code> shows a line above the website while the paid tier is open, linking to an offer, and it hides
					itself when the offer ends.
				</p>
			</Section>

			<Section title="Gift subscriptions" stagger={8}>
				<p>
					<Code>set_gifts</Code> turns on gifts for a newsletter with its paid tier open. The gift page, <Code>/give</Code> on the
					newsletter&apos;s site, sells 1, 3, 6 or 12 months of a tier: a year is the yearly price, a quarter the quarterly price when there is one,
					and the rest are months of the monthly price. The buyer names the recipient, writes a message (plain text, no links) and picks the day it
					is sent, up to a year ahead, and pays once with Stripe Checkout on your account. A lifetime or pay what you want tier isn&apos;t given.
				</p>
				<p className="mt-4">
					When the payment is confirmed the buyer gets a receipt with a page that lists their gifts and whether each was redeemed. On the chosen day
					(a job per gift, with an hourly check behind it) the recipient gets one email from the newsletter with the message and a link. Redeeming
					gives paid access for the gift&apos;s months <em>from that day</em>, or from when their other paid time ends, as a gift: it is shown apart
					from paying readers. <strong>An unredeemed gift expires 12 months after it was bought.</strong> The payment stays with you, and refunding it
					in Stripe is yours to do; a full refund of a redeemed gift takes the access back. <Code>list_gifts</Code> shows every gift and{" "}
					<Code>resend_gift</Code> sends one again, to another address if the first didn&apos;t reach.
				</p>
			</Section>

			<Section title="Comp access and the paid report" stagger={9}>
				<p>
					<Code>grant_comp_access</Code> gives a contact paid access by hand until a day, in a tier: for press, partners or a favor. The contact
					has to be on the list and active already, because paid issues are email they would otherwise not have asked for. The access ends on its
					day by itself (an hourly check clears it and tells webhooks), or sooner with <Code>revoke_comp_access</Code>. A comp is shown apart: a
					contact&apos;s <Code>paidAccess</Code> says <Code>stripe</Code>, <Code>comp</Code> or <Code>gift</Code>, and a reader who also pays with
					a Stripe subscription keeps paying while the comp waits behind it.
				</p>
				<p className="mt-4">
					<Code>get_paid_report</Code> counts paying readers, comps and gifts per tier. Only paying readers count towards its monthly revenue,
					which is an estimate at list prices: it leaves out comps, gifts, lifetime payments and discounts. Your Stripe dashboard has the exact
					figures.
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
