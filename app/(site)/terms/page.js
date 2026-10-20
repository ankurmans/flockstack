import { notFound } from "next/navigation";
import LayoutLegal from "@/components/LayoutLegal";
import LinkInline from "@/components/LinkInline";
import SectionLegal from "@/components/SectionLegal";
import { DELETION_GRACE_DAYS } from "@/lib/account-deletion";
import { EXPORT_LINK_DAYS } from "@/lib/account-export-files";
import { FREE_LIMITS, LIMITS } from "@/lib/config";
import { formatNumber } from "@/lib/format";
import {
	GOVERNING_LAW,
	LEGAL_PAGES,
	LIABILITY_CAP,
	MINIMUM_AGE,
	OPERATOR_DESCRIPTION,
	OPERATOR_NAME,
	PRICE_INCREASE_NOTICE_DAYS,
	PRIVACY_EMAIL,
	TAX_NOTE,
	TERMS_CHANGE_NOTICE,
	YEARLY_REFUND_DAYS,
	isLegalPublished,
} from "@/lib/legal";
import { FREE_GUARDS, FREE_PLAN } from "@/lib/plans";
import { getRegionUrls } from "@/lib/region";
import { getPageMetadata } from "@/lib/site";

const { title, description, href } = LEGAL_PAGES.find((page) => page.href === "/terms");
export const metadata = getPageMetadata({ title, description, path: href });

// 0.08, 0.003 and 0.05 as the percentages people read: 0.08%, 0.3%, 5%.
const percent = (rate) => `${Number((rate * 100).toFixed(2))}%`;

export default function TermsPage() {
	if (!isLegalPublished()) notFound();
	const urls = getRegionUrls();
	const { pause, block } = LIMITS;
	const free = FREE_LIMITS;

	return (
		<LayoutLegal
			title="Terms of service"
			current={href}
			intro="The rules for using FlockStack Cloud, in plain words. Your newsletter and your subscribers stay yours."
		>
			<SectionLegal id="service" title="The service">
				<p>
					FlockStack is a newsletter app: you write issues, send them to your subscribers and publish them on the web, from the dashboard,
					the REST API or an MCP server that AI assistants can use. FlockStack Cloud is the hosted version, run by {OPERATOR_DESCRIPTION}{" "}
					(&quot;we&quot;, &quot;us&quot;) at {new URL(urls.us).host} and {new URL(urls.eu).host}. These terms are between you and us. By signing
					in or using FlockStack Cloud you agree to them and to the <LinkInline href="/privacy">privacy policy</LinkInline>.
				</p>
				<p>
					<strong className="font-medium text-foreground">Open source.</strong> FlockStack&apos;s code is licensed under the AGPL-3.0, and
					anyone can run it on their own server. That licence covers the code. These terms cover the hosted service we run, which is a
					separate thing: running your own copy needs none of this, and using ours doesn&apos;t change your rights under the licence.
				</p>
			</SectionLegal>

			<SectionLegal id="accounts" title="Your account">
				<p>
					You sign in with a code we email you, with a passkey, or with Google. Use an inbox you control. We allow one
					account for each inbox, and we don&apos;t accept throwaway inboxes. You must be at least {MINIMUM_AGE}.
				</p>
				<p>
					You are responsible for what happens in your account, including what is done with your API keys and the apps you connect to it.
					Keep keys secret, and revoke any that leaked. Tell us at <LinkInline href={`mailto:${PRIVACY_EMAIL}`}>{PRIVACY_EMAIL}</LinkInline> if you think someone else got in.
				</p>
				<p>
					When you sign up, you choose where your data is stored: the United States or the European Union. An account lives in one region.
					We don&apos;t move accounts between regions. <LinkInline href="/docs/regions">The regions page</LinkInline> lists what is stored where.
				</p>
			</SectionLegal>

			<SectionLegal id="plans" title="Plans and billing">
				<p>
					A plan sets how many emails you can send in a month and how many active subscribers you can have. Prices are in US dollars, billed
					monthly or yearly (a yearly plan costs 10 months, not 12), and shown on the pricing section of the home page. You pay through our
					billing provider, Polar. Your card details go to them, not to us. Every email you send counts toward the month: issues, tests,
					welcome emails and confirmation emails. If you reach the limit on a paid plan, sending goes on and we bill extra emails at the
					price on the home page, with your plan at the end of the period, up to a monthly limit you set on the billing page; confirmation
					emails are never billed as extra. At that limit, on the Free plan, or on a plan we gave you for free, sending stops with a message
					and an upgrade link. A dedicated
					IP is an optional add-on with its own price, which you buy separately. Nothing else is billed on top of your plan. {TAX_NOTE}
				</p>
				<p>
					<strong className="font-medium text-foreground">The Free plan.</strong> Every account starts on the Free plan, which costs
					nothing and needs no card: up to {formatNumber(FREE_PLAN.subscribers)} active subscribers, {formatNumber(FREE_PLAN.emailsPerMonth)} emails a month,{" "}
					{FREE_PLAN.newsletters} newsletter and {FREE_PLAN.automations} automations besides the welcome email. It never goes past its
					limits and is never billed: a send that wouldn&apos;t fit in the month&apos;s emails is refused, with the numbers, until the month
					resets or you upgrade. Emails and websites on the Free plan carry a small &ldquo;Sent with FlockStack&rdquo; link, which every paid
					plan removes. To keep the Free plan fair for everyone, your first {FREE_GUARDS.firstCampaigns.count} campaigns go to at most{" "}
					{formatNumber(FREE_GUARDS.firstCampaigns.recipients)} people each until they have gone out and settled with few complaints, and its
					bounce and complaint levels are lower (below). We may pause or block an account that abuses the Free plan, for example by sending
					to people who didn&apos;t ask, or by opening accounts to get around its limits. If a paid plan ends, the account goes back to the
					Free plan and keeps everything: if it has more subscribers than the Free plan allows, nothing is deleted, but campaigns wait until
					it is under the limit or you upgrade.
				</p>
				<p>
					<strong className="font-medium text-foreground">Cancelling a monthly plan.</strong> Cancel any time from the billing page, which
					opens the billing portal. The subscription ends when you cancel, and you keep access through the end of the period you already paid
					for. We don&apos;t refund the current month.
				</p>
				<p>
					<strong className="font-medium text-foreground">Yearly plans.</strong> Ask for a refund within {YEARLY_REFUND_DAYS} days of buying
					and we refund the unused part of the year, pro rata, through the billing provider. Write to{" "}
					<LinkInline href={`mailto:${PRIVACY_EMAIL}`}>{PRIVACY_EMAIL}</LinkInline>. Outside those {YEARLY_REFUND_DAYS} days, cancelling
					a yearly plan works like a monthly one: you keep access to the end of the year you paid for, with no refund.
				</p>
				<p>
					If a payment fails, the provider tries the card again, and your plan keeps working in the meantime. If it still fails, the plan
					ends like a cancelled one. A cancelled account goes back to the Free plan and keeps its data, its website and its signups; what
					goes beyond the Free plan&apos;s limits waits until you subscribe again. You can export, or delete the account, at any time.
				</p>
				<p>
					<strong className="font-medium text-foreground">Price changes.</strong> We email you at least {PRICE_INCREASE_NOTICE_DAYS} days
					before a price increase takes effect for your plan, so you can cancel or export first.
				</p>
			</SectionLegal>

			<SectionLegal id="acceptable-use" title="Acceptable use">
				<p>FlockStack shares its sending reputation across every account, so these rules protect all of us.</p>
				<ul>
					<li>
						<strong className="font-medium text-foreground">Email people who asked.</strong> Everyone on your list must have agreed to
						get your emails. Confirmed opt-in is on by default for new newsletters, and importing a list means saying that these people
						agreed to receive your emails. No bought, rented or scraped lists.
					</li>
					<li>
						<strong className="font-medium text-foreground">Be honest.</strong> Say who you are: use your own name or your newsletter&apos;s,
						a real reply address and a real postal address, which every email prints. Don&apos;t mislead people about who sends the email
						or what it is. Don&apos;t remove or hide the unsubscribe link, which FlockStack adds to every email, and don&apos;t email people
						who unsubscribed.
					</li>
					<li>
						<strong className="font-medium text-foreground">Nothing illegal.</strong> No scams, phishing or malware, no content that
						sexually exploits children, no threats or harassment, no content that infringes someone else&apos;s rights, and nothing else
						the law forbids where you or your readers are.
					</li>
					<li>
						<strong className="font-medium text-foreground">Don&apos;t work around the service.</strong> Don&apos;t get past limits or
						blocks, probe other accounts, overload the service or use the API or an AI assistant to do any of the above.
					</li>
					<li>
						<strong className="font-medium text-foreground">Follow the law that applies to your emails</strong> (for example CAN-SPAM, the GDPR
						and ePrivacy, CASL). You are responsible for it, see below.
					</li>
				</ul>
			</SectionLegal>

			<SectionLegal id="sending-limits" title="Bounces, complaints and blocks">
				<p>
					Mailbox providers judge every sender by how many emails bounce and how many readers mark them as spam. FlockStack watches both,
					and acts on its own at these levels (out of emails sent, with a minimum number so one complaint never stops anything):
				</p>
				<ul>
					<li>
						<strong className="font-medium text-foreground">A campaign pauses</strong> past {percent(pause.bounceRate)} hard bounces
						(at least {pause.minBounces}) or {percent(pause.complaintRate)} complaints (at least {pause.minComplaints}). You are emailed,
						and you can resume it.
					</li>
					<li>
						<strong className="font-medium text-foreground">The account is blocked</strong> past {percent(block.bounceRate)} hard bounces
						(at least {block.minBounces}) or {percent(block.complaintRate)} complaints (at least {block.minComplaints}), measured on a campaign,
						on the first slice of a first send, or over the last 7 days. It is also blocked when an email reaches a spam trap, when Gmail&apos;s
						spam rate for your account reaches {percent(block.complaintRate)}, when our email provider stops your sending, and when we block it
						ourselves.
					</li>
				</ul>
				<p>
					On the Free plan the levels are lower: a campaign pauses past {percent(free.pause.bounceRate)} hard bounces (at least{" "}
					{free.pause.minBounces}) or {percent(free.pause.complaintRate)} complaints (at least {free.pause.minComplaints}), and the account is
					blocked past {percent(free.block.bounceRate)} (at least {free.block.minBounces}) or {percent(free.block.complaintRate)} (at least{" "}
					{free.block.minComplaints}).
				</p>
				<p>
					Contacts you have never emailed go out in steps: a first slice, a check of its bounces and complaints 3 hours later, then the rest.
					Large sends are spread over hours while an account builds a sending history.
				</p>
				<p>
					<strong className="font-medium text-foreground">What a block does.</strong> Nothing is sent from the account, welcome and confirmation
					emails included. Imports, new contacts, signups on your website and most changes are off, except stopping things (pausing,
					unscheduling, revoking keys and apps) and billing. The tracked links in your past emails stop redirecting and show a page saying the
					link is disabled. Unsubscribe links keep working, and so does your export.
				</p>
				<p>
					<strong className="font-medium text-foreground">We always tell you why.</strong> The reason is shown on your dashboard and in the
					email we send when your account is blocked, and when we block an account by hand we write the reason ourselves. Nothing lifts a
					block on its own: write to us at <LinkInline href={`mailto:${PRIVACY_EMAIL}`}>{PRIVACY_EMAIL}</LinkInline> and we
					review it. If the block is right, we say what has to change.
				</p>
			</SectionLegal>

			<SectionLegal id="your-data" title="Your content and your subscribers">
				<p>
					Your newsletters, issues, images, lists and settings are yours. You give us the right to store, process, send and display them as
					needed to run the service for you, and nothing more. We don&apos;t use them for advertising and we don&apos;t sell them.
				</p>
				<p>
					If you turn on comments on your newsletter&apos;s website, they are your site&apos;s: you decide what stays, and whatever you hold, hide or
					remove has a reason its author reads.
				</p>
				<p>
					You are the controller of your subscribers&apos; personal data, and FlockStack is your processor: we handle it on your behalf and on
					your instructions, which are what you do in the product. You are responsible for having a lawful basis to email them, for telling them
					what you do with their data, and for answering their requests. The <LinkInline href="/sub-processors">sub-processors page</LinkInline>{" "}
					lists the services we use to do that and explains how to ask for a data processing agreement.
				</p>
			</SectionLegal>

			<SectionLegal id="selling" title="Selling to your readers">
				<p>
					If you sell digital products or paid subscriptions, your readers pay your own Stripe account, connected to FlockStack through Stripe
					Connect. FlockStack takes 0% of what you sell: we set no application fee. Stripe&apos;s own processing fees apply and come off your
					sales. You are the seller: you are responsible for what you sell, for refunds and disputes, for taxes on your sales, and for
					following Stripe&apos;s terms. A refund or a chargeback stops the buyer&apos;s download link on its own.
				</p>
			</SectionLegal>

			<SectionLegal id="leaving" title="Leaving, and your export">
				<p>
					You can export everything, free, at any time: contacts as CSV, every issue as Markdown and HTML, your images, your suppression list and
					a manifest. It works even if your account is blocked or paused. The download links last {EXPORT_LINK_DAYS} days.
				</p>
				<p>
					You can delete your account from the account page. If you pay for a plan, cancel it first, and finish or unschedule any campaign that is
					sending. The account stops at once, you can restore it by signing in within {DELETION_GRACE_DAYS} days, and after that its data is
					deleted for good. <LinkInline href="/privacy#retention">The privacy policy</LinkInline> says what is deleted and what is kept.
				</p>
				<p>
					We can suspend or end an account that breaks these terms, and we say why. Blocks work as described above. Your export stays available
					while the account exists.
				</p>
			</SectionLegal>

			<SectionLegal id="liability" title="Warranty and liability">
				<p>
					FlockStack Cloud is provided as it is. We work to keep it running, but we don&apos;t promise it will always be available or free of
					errors, and we can&apos;t promise that an email reaches an inbox: that depends on mailbox providers.
				</p>
				<p>
					To the extent the law allows, we are not liable for indirect or lost-profit damages, and our total liability to you for anything
					connected to the service is limited to {LIABILITY_CAP}. Nothing in these terms limits liability that the law doesn&apos;t allow to be
					limited, or takes away rights you have under mandatory law where you live.
				</p>
			</SectionLegal>

			<SectionLegal id="law" title="Governing law">
				<p>
					These terms are governed by the laws of {GOVERNING_LAW}, and the courts there have jurisdiction over disputes about them, subject to
					any mandatory rights you have where you live.
				</p>
			</SectionLegal>

			<SectionLegal id="changes" title="Changes">
				<p>
					We may change these terms. {TERMS_CHANGE_NOTICE} Price increases for your plan always get {PRICE_INCREASE_NOTICE_DAYS} days&apos;
					notice, as described above. If you don&apos;t agree with a change, cancel and export before it takes effect.
				</p>
			</SectionLegal>

			<SectionLegal id="contact" title="Contact">
				<p>
					{OPERATOR_NAME}, <LinkInline href={`mailto:${PRIVACY_EMAIL}`}>{PRIVACY_EMAIL}</LinkInline>.
				</p>
			</SectionLegal>
		</LayoutLegal>
	);
}
