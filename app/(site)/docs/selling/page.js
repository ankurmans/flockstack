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
			<HeaderDocs kicker="Guides" title="Selling">
				Sell digital products and paid subscriptions to your readers, from the dashboard, the REST API or an AI assistant. Readers pay your
				own Stripe account. FlockStack takes no cut: only Stripe&apos;s processing fee comes off a sale.
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
