import { notFound } from "next/navigation";
import LayoutLegal from "@/components/LayoutLegal";
import LinkInline from "@/components/LinkInline";
import SectionLegal from "@/components/SectionLegal";
import { DELETION_GRACE_DAYS } from "@/lib/account-deletion";
import { EXPORT_LINK_DAYS } from "@/lib/account-export-files";
import { REGION_LEAVES } from "@/lib/docs/regions";
import {
	ANALYTICS_RETENTION,
	ANALYTICS_RULE,
	BACKUP_RETENTION,
	LEGAL_PAGES,
	LOG_RETENTION,
	MINIMUM_AGE,
	OPERATOR_DESCRIPTION,
	PRIVACY_EMAIL,
	PRIVACY_REQUEST_RESPONSE,
	SUPPORT_AI_PROVIDER_NOTE,
	SUPPORT_CHAT_RETENTION,
	SUPPORT_CHAT_STORED,
	TERMS_CHANGE_NOTICE,
	TRANSFER_SAFEGUARDS,
	isLegalPublished,
} from "@/lib/legal";
import { REGION_NAMES } from "@/lib/region";
import { getPageMetadata } from "@/lib/site";

const { title, description, href } = LEGAL_PAGES.find((page) => page.href === "/privacy");
export const metadata = getPageMetadata({ title, description, path: href });

const Strong = ({ children }) => <strong className="font-medium text-foreground">{children}</strong>;

export default function PrivacyPage() {
	if (!isLegalPublished()) notFound();
	const mail = <LinkInline href={`mailto:${PRIVACY_EMAIL}`}>{PRIVACY_EMAIL}</LinkInline>;

	return (
		<LayoutLegal
			title="Privacy policy"
			current={href}
			intro="What FlockStack Cloud collects, why, how long it keeps it and how to use your rights. We have no ads and we sell nothing."
		>
			<SectionLegal id="who" title="Who we are">
				<p>
					FlockStack Cloud is run by {OPERATOR_DESCRIPTION} (&quot;we&quot;). Questions, requests and complaints about privacy go to {mail}.
					This policy covers FlockStack Cloud. A FlockStack server run by someone else is theirs, and they set its policy.
				</p>
				<p>
					We are two things here. For the people who sign up (<Strong>account holders</Strong>, the creators), we are the controller of
					their account data. For a creator&apos;s <Strong>subscribers</Strong>, the creator decides why and how their data is used and we
					are their processor: we handle it for them. Each section says which one it is about.
				</p>
			</SectionLegal>

			<SectionLegal id="account-data" title="What we collect from account holders">
				<ul>
					<li>
						<Strong>Your account:</Strong> your email address, and the name and photo if you add them. Sign-in codes are stored hashed, work
						once, last 5 minutes and die after 3 wrong tries. If you add a passkey we store its public key; if you sign in with Google or
						Apple we store that link to your Google or Apple account. With Apple, your email can be a private relay address that Apple forwards
						to your inbox, and we get your name only the first time, if you choose to share it.
					</li>
					<li>
						<Strong>Sessions and sign-in records:</Strong> each session records the IP address and browser it started from. Our logs have a line
						for each sign-in (your email, IP address and browser) and for some actions: sending a campaign, creating an API key, connecting an
						app, deleting an account.
					</li>
					<li>
						<Strong>Your newsletters:</Strong> their names, addresses, sender details, postal address, issues, images, products, domains
						and settings, which are what you put in them.
					</li>
					<li>
						<Strong>API keys and connected apps:</Strong> keys are stored hashed. Apps you connect (such as an AI assistant) get a token and
						full access to the account until you disconnect them.
					</li>
					<li>
						<Strong>Webhooks:</Strong> the addresses you add, their signing secrets, and a log of the latest 100 deliveries to each, with what
						was sent and the answer.
					</li>
					<li>
						<Strong>Your plan:</Strong> which plan, monthly or yearly, its status and period dates, and the IDs of your customer and
						subscription at our billing provider. The provider handles your payment details. We don&apos;t store card numbers.
					</li>
					<li>
						<Strong>If you sell:</Strong> the ID and status of your connected Stripe account (charges and payouts enabled), and the orders
						described below.
					</li>
					<li>
						<Strong>Alerts and messages:</Strong> the emails we send you about your account, and your messages if you write to us.
					</li>
					<li>
						<Strong>How you use FlockStack&apos;s own pages:</Strong> we use PostHog, our product analytics, to see page views, clicks and
						actions, your device and browser, your approximate location and, when you are signed in, your user ID, email address and plan.
						{" "}{ANALYTICS_RULE} Retention: {ANALYTICS_RETENTION}
					</li>
					<li>
						<Strong>The support assistant:</Strong> FlockStack&apos;s own assistant answers from our docs and from what you type to it. It runs
						on Cloudflare Workers AI, which runs on Cloudflare&apos;s global network, so what you type may be processed outside your region.
						Stored: {SUPPORT_CHAT_STORED}. How long: {SUPPORT_CHAT_RETENTION} {SUPPORT_AI_PROVIDER_NOTE}
					</li>
					<li>
						<Strong>Rate-limit counters:</Strong> to stop abuse, we count requests to sign-in, signup and similar forms by IP address, and
						questions to the support assistant by IP address and user ID. The counters last minutes to two days and are cleaned up.
					</li>
				</ul>
			</SectionLegal>

			<SectionLegal id="subscriber-data" title="What we handle for your subscribers">
				<p>These are the creator&apos;s data, which we hold and process for them.</p>
				<ul>
					<li>
						<Strong>The list:</Strong> each subscriber&apos;s email address, status (active, pending, unsubscribed, bounced, complained or
						dormant), where they signed up from, the dates they signed up, confirmed and left, and the tags and fields the creator sets.
						Imports can carry the engagement a subscriber had on the previous platform.
					</li>
					<li>
						<Strong>Emails sent:</Strong> a record of each email (recipient, kind, status, and when it was sent, delivered, opened, clicked,
						bounced or complained) and the issues themselves. Bounce and complaint events are kept with the address.
					</li>
					<li>
						<Strong>Opens and clicks:</Strong> emails carry a one-pixel image and links that pass through FlockStack, so the creator sees
						that an email was opened or a link clicked, and when. We store the fact and its time, not the reader&apos;s IP address or device.
						Visits that look like security scanners aren&apos;t counted as clicks.
					</li>
					<li>
						<Strong>Referrals:</Strong> when a signup comes through a referral link, a keyed hash of the visitor&apos;s IP address is stored,
						to tell a household from a farm. The IP address itself is only used to limit signups per visitor.
					</li>
					<li>
						<Strong>Orders:</Strong> when readers buy from a creator, the creator&apos;s Stripe account takes the payment. We keep the
						buyer&apos;s email and name, the product, the amount and the download count.
					</li>
					<li>
						<Strong>Comments:</Strong> if the creator turns comments on, a subscriber signs in to a newsletter&apos;s website with a link
						emailed to them (no password) and a cookie keeps them signed in for that newsletter for 30 days. A comment is stored with a display
						name that starts as the part of the email address before the @ and is never shown with the address, its text and its status, the
						reason it was held, hidden or removed, and two keyed hashes: one of the IP address (to limit spam) and one of the text (to catch a
						repeat). Reports of a comment, with the reason if given, are kept too. A reader gets an email when someone replies, and can turn
						those off.
					</li>
					<li>
						<Strong>Recommendations:</Strong> a newsletter can recommend others to its readers. Nothing is ticked beforehand. A reader&apos;s
						email address reaches another newsletter only when that reader ticks it and subscribes, as a normal signup with that newsletter&apos;s
						own confirmation email. That newsletter&apos;s owner then sees where the subscriber came from. Pages that showed a recommendation
						are counted without personal data.
					</li>
					<li>
						<Strong>Web pages:</Strong> a newsletter&apos;s website counts a view per issue, browser and day, with no personal data.
					</li>
				</ul>
				<p>
					<Strong>Never-email list.</Strong> Across all accounts we keep one list of addresses that are known not to exist (hard bounces,
					kept 180 days) or that are spam traps (kept with no end date). It is stored as a keyed hash that can&apos;t be turned back into an
					address and doesn&apos;t say which creator it came from. We run it to protect everyone&apos;s sending reputation, on our legitimate
					interest, and it is the one place where something about a subscriber is shared between creators.
				</p>
			</SectionLegal>

			<SectionLegal id="not-doing" title="What we don't do">
				<ul>
					<li>No advertising and no selling or renting of personal data.</li>
					<li>
						No sharing of one creator&apos;s subscribers with another creator or anyone else, apart from the hashed never-email list above,
						a reader ticking a recommendation, the sub-processors we need to run the service, and the webhook addresses a creator adds
						(their own server, or an app like Zapier or Make), which get the events the creator picked.
					</li>
					<li>
						We don&apos;t use subscribers&apos; data for anything but running the creator&apos;s newsletter, and we don&apos;t track readers
						with analytics: PostHog is not loaded on newsletters&apos; pages or on the pages readers use.
					</li>
					<li>
						FlockStack sends your newsletters and subscribers to no AI service. The one AI feature is the support assistant, which sees what you
						type to it. If you connect your own AI assistant to your account, that is your choice, and its provider&apos;s terms apply.
					</li>
				</ul>
			</SectionLegal>

			<SectionLegal id="legal-bases" title="Why we may use it">
				<p>For people in the EU, the UK and similar places, the GDPR asks for a legal basis. Ours:</p>
				<ul>
					<li>
						<Strong>Contract:</Strong> your account, your plan, and sending your newsletters are what you asked us to do.
					</li>
					<li>
						<Strong>Legitimate interests:</Strong> keeping the service secure and free of abuse (sign-in records, rate limits, the
						never-email list, the record we keep of deleted accounts), protecting the sending reputation every customer shares, and, on
						visitors outside the EU, the EEA, the UK and Switzerland, who see no banner and can switch it off in Cookie settings, understanding how people
						use FlockStack&apos;s pages.
					</li>
					<li>
						<Strong>Legal obligation:</Strong> records our billing provider and we must keep for tax and accounting.
					</li>
					<li>
						<Strong>Consent:</Strong> where we ask for it, and you can withdraw it. On eu.flockstack.io and for visitors in the EU, the EEA, the UK
						and Switzerland, FlockStack&apos;s analytics runs only after you accept it. For a creator&apos;s subscribers, the creator chooses the basis (usually consent) and we process on their
						instructions.
					</li>
				</ul>
			</SectionLegal>

			<SectionLegal id="retention" title="How long we keep it, and deleting it">
				<ul>
					<li>
						<Strong>An account&apos;s data</Strong> stays while the account exists. If a plan ends, the data stays and nothing is deleted on
						a timer: delete the account to remove it.
					</li>
					<li>
						<Strong>Deleting an account</Strong> (account page, with a code sent to your email) stops it at once, signs you out everywhere and
						revokes keys and apps. You can restore it by signing in within {DELETION_GRACE_DAYS} days. After that we delete the user and
						sessions, contacts, issues, sent-email records and events, API keys, images, product files, exports, domains and the sending
						set-up at our email provider. A paid plan has to be cancelled first.
					</li>
					<li>
						<Strong>What stays after that:</Strong> a record with a keyed hash of the owner&apos;s email address, the dates the account was
						created, deleted and purged, and its internal ID. It lets us notice the same address signing up again, so abuse can&apos;t simply
						start over. It has no end date yet. Our billing provider and Stripe keep their own records under their own rules.
					</li>
					<li>
						<Strong>Deleting a subscriber.</Strong> A creator deleting a contact removes the contact and its fields. For a subscriber who
						unsubscribed, bounced or complained, a keyed hash of the address and the status are kept so the newsletter never emails them again.
						The records of emails already sent to the address, and of its bounces and complaints, stay until the account is deleted. The
						subscriber&apos;s comments stay, shown as written by &quot;Deleted reader&quot;, with the link to the person and the two
						hashes removed; the text of a comment stays as it was written. The reports they made are deleted.
					</li>
					<li>
						<Strong>Exports</Strong> are private files, deleted when their links expire after {EXPORT_LINK_DAYS} days.
					</li>
					<li>
						<Strong>Logs:</Strong> {LOG_RETENTION}
					</li>
					<li>
						<Strong>Backups:</Strong> {BACKUP_RETENTION}
					</li>
				</ul>
			</SectionLegal>

			<SectionLegal id="where" title="Where your data lives">
				<p>
					You choose a region when you sign up: the {REGION_NAMES.us} or the {REGION_NAMES.eu}. Each region has its own database and storage.
					An account lives in exactly one, and what you store is stored in that region. Data stored in the EU is the most we say: some
					things pass through, or are kept, beyond the region.
				</p>
				<ul>
					{REGION_LEAVES.map((item) => (
						<li key={item}>{item}</li>
					))}
				</ul>
				<p>
					<LinkInline href="/docs/regions">The regions page</LinkInline> lists where each kind of data is stored. The{" "}
					<LinkInline href="/sub-processors">sub-processors page</LinkInline> lists who runs what.
				</p>
			</SectionLegal>

			<SectionLegal id="transfers" title="Transfers outside your country">
				<p>
					Our services are run by companies based in the United States, and some data crosses borders however you choose: the code runs in the
					Cloudflare data center closest to a visitor, emails travel to wherever the reader&apos;s mailbox is, billing is one account for both
					regions, and the support assistant runs on Cloudflare&apos;s global network. When data goes to a country without the same protection as
					yours, we rely on the safeguards in the provider&apos;s own data processing terms. This is what each one says on the page we link, no
					more:
				</p>
				<ul>
					{TRANSFER_SAFEGUARDS.map(({ name, text, source }) => (
						<li key={name}>
							<Strong>{name}.</Strong> {text} (<LinkInline href={source}>source</LinkInline>)
						</li>
					))}
				</ul>
			</SectionLegal>

			<SectionLegal id="rights" title="Your rights">
				<p>
					You can ask to see your data, correct it, export it, delete it, restrict how it is used or object to it, and, where you gave consent,
					withdraw it. Most of it you can do yourself: change your details on the account page, <LinkInline href="/docs/export">export
					everything</LinkInline> in one click, or delete the account. For anything else, write to {mail}. We may ask you to prove that
					you control the email address first. {PRIVACY_REQUEST_RESPONSE} If you think we got it wrong, you can complain to your data
					protection authority.
				</p>
				<p>
					<Strong>If you are a creator&apos;s subscriber,</Strong> the creator is the one to ask: the sender&apos;s name and postal address are
					in every email, and you can reply to it. To stop getting a newsletter, use the unsubscribe link in any of its emails or the one-click
					unsubscribe in your mail app: you are marked as unsubscribed at once, and the address stays on the list as unsubscribed so the
					newsletter can&apos;t email it again. To have your address deleted, ask the creator, who can delete it from their dashboard or API.
					If you can&apos;t reach them, write to {mail} and we will tell you who to contact.
				</p>
			</SectionLegal>

			<SectionLegal id="cookies" title="Cookies and local storage">
				<p>FlockStack itself sets these, all needed for the service:</p>
				<ul>
					<li>
						<Strong>A session cookie</Strong> (<code>better-auth.session_token</code> in the United States, <code>flockstack-eu.session_token</code>{" "}
						in the EU) while you are signed in, and short-lived sign-in cookies while you use a passkey, Google or Apple. They are needed to sign you in.
					</li>
					<li>
						<Strong><code>region</code></Strong>, for a year: the region you picked on the home page or sign-in page.
					</li>
					<li>
						<Strong><code>fs_consent</code></Strong>, for a year: whether you accepted or declined analytics, so we don&apos;t ask again.
					</li>
					<li>
						<Strong><code>tz</code></Strong> and <Strong><code>newsletter</code></Strong>, for a year, in the dashboard: your time zone, and the newsletter
						you have open.
					</li>
					<li>
						<Strong><code>fs_reader_&lt;newsletter&gt;</code></Strong> and a marker, <Strong><code>fs_reader_&lt;newsletter&gt;_on</code></Strong>, for 30 days, on a
						newsletter&apos;s website: they keep a subscriber signed in to comment on that newsletter, and only exist after the subscriber used a
						sign-in link.
					</li>
				</ul>
				<p>
					<Strong>Analytics.</Strong> FlockStack&apos;s own pages load PostHog, which sets its own cookies or local storage (their names start with{" "}
					<code>ph_</code>) to tell visits apart. {ANALYTICS_RULE} Those are not on this list because they are not needed for the service. When you
					sign up, set up your first newsletter or start a plan, FlockStack also sets <code>fs_goal</code> for ten minutes, which the next page reads
					once to count that step and removes. It is set only while analytics is on. Change your choice any time with <Strong>Cookie settings</Strong>{" "}
					in the footer of the home page, the docs and the legal pages, and on the sign-in page. Declining deletes the PostHog cookies and local
					storage.
				</p>
				<p>
					Your browser&apos;s own storage keeps your light or dark theme, the support assistant&apos;s conversation in that tab&apos;s session storage until you
					close the tab or sign out, and on a newsletter&apos;s website, whether you subscribed, whether
					you snoozed the signup prompt, a referral code for 30 days, the newsletter that sent you there through a recommendation for 7 days, and a
					marker that you viewed an issue today. None of it is sent as a cookie.
				</p>
			</SectionLegal>

			<SectionLegal id="security" title="Security">
				<p>
					Pages are served over HTTPS. API keys and sign-in codes are stored hashed, unsubscribe and tracking links are signed, every query is
					scoped to one account, and product files and exports sit in private storage and leave it only through signed links that expire. No
					system is perfectly safe, so please tell us at {mail} if you find a problem.
				</p>
			</SectionLegal>

			<SectionLegal id="children" title="Children">
				<p>
					FlockStack is not for people under {MINIMUM_AGE}, and we don&apos;t knowingly collect their data. If you think a child has an account,
					write to {mail} and we will delete it. Creators are responsible for who is on their lists.
				</p>
			</SectionLegal>

			<SectionLegal id="changes" title="Changes">
				<p>
					When we change this policy we update the date at the top. {TERMS_CHANGE_NOTICE}
				</p>
			</SectionLegal>

			<SectionLegal id="contact" title="Contact">
				<p>
					{OPERATOR_DESCRIPTION}, {mail}. See also the <LinkInline href="/terms">terms of service</LinkInline>.
				</p>
			</SectionLegal>
		</LayoutLegal>
	);
}
