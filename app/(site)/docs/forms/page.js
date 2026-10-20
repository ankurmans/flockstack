import Link from "next/link";
import BlockCode from "@/components/BlockCode";
import HeaderDocs from "@/components/HeaderDocs";
import { getDocsPageMetadata } from "@/lib/docs/pages";
import { MAX_FORMS_PER_NEWSLETTER, MAX_FORM_FIELDS } from "@/lib/form-rules";
import { MAGIC_PER_EMAIL, MAGIC_PER_IP } from "@/lib/magic-links";
import { POPUP_DEFAULTS, POPUP_LIMITS } from "@/lib/popup-rules";

export const metadata = getDocsPageMetadata("/docs/forms");

const SCRIPT = '<script async src="https://your-slug.example.com/embed.js" data-flockstack-form="FORM_ID"></script>';
const HTML = `<form action="https://your-slug.example.com/f/FORM_ID" method="post">
  <input type="email" name="email" placeholder="you@example.com" required>
  <input type="text" name="website" tabindex="-1" autocomplete="off" aria-hidden="true" style="position:absolute;left:-10000px">
  <button type="submit">Subscribe</button>
</form>`;
const JSON_POST = `curl -X POST https://your-slug.example.com/f/FORM_ID \\
  -H "Content-Type: application/json" \\
  -d '{"email":"jane@example.com","utm_source":"my-site"}'`;

const MAGIC = "https://your-slug.example.com/subscribe/magic?email=*|EMAIL|*&k=1&sig=…&utm_source=their-newsletter&utm_campaign=swap-12";

export default function FormsPage() {
	return (
		<>
			<HeaderDocs kicker="Guides" title="Forms, pop-ups and Magic Links">
				Put a signup form on any site, bring in readers from other newsletters with one link, and keep track of where every subscriber came from.
			</HeaderDocs>

			<Section title="Signup forms for other sites" stagger={1}>
				<p>
					Make a form on the{" "}
					<Link href="/forms" className="font-medium text-link underline decoration-link/30 underline-offset-4 hover:decoration-link">
						Forms page
					</Link>{" "}
					or with <Code>create_form</Code>: a name, the button&apos;s words, up to {MAX_FORM_FIELDS} of the newsletter&apos;s custom fields after the email (a
					first name is a custom field), colors that start from the newsletter&apos;s accent color, and what happens after a signup: a message, or a
					page of yours to go to. A newsletter has up to {MAX_FORMS_PER_NEWSLETTER} forms. Every form is a page on the newsletter&apos;s own host, and
					the Forms page gives you the code for it.
				</p>
				<p className="mt-4">
					<strong className="font-medium text-foreground">One line.</strong> It puts the form where the script stands, in a frame that sets its own
					height as the form changes. The frame only listens to messages from the newsletter&apos;s host and only to its own frame, and the only
					things it can ask for are a height and, if you chose a page to go to, that page.
				</p>
				<BlockCode title="Any page" className="mt-3" code={SCRIPT} />
				<p className="mt-4">
					<strong className="font-medium text-foreground">Plain HTML.</strong> For a site that doesn&apos;t allow scripts or frames: a form that posts to
					the form&apos;s address. The visitor lands on the form&apos;s page with the result, or on your own page if you set one. The hidden
					field is a trap for bots: leave it empty and out of sight.
				</p>
				<BlockCode title="HTML form" className="mt-3" code={HTML} />
				<p className="mt-4">
					<strong className="font-medium text-foreground">From a script of your own.</strong> The same address takes JSON, from any site: it
					answers <Code>{"{ \"ok\": true }"}</Code> or <Code>{"{ \"ok\": false, \"error\": \"…\" }"}</Code>. For a form you build entirely yourself,{" "}
					<Code>add_contact</Code> with a signups only key does the same.
				</p>
				<BlockCode title="JSON" className="mt-3" code={JSON_POST} />
			</Section>

			<Section title="What a signup goes through" stagger={2}>
				<p>
					The same checks as the signup form on the website. The newsletter&apos;s confirmed opt-in applies, so a new address gets the confirmation email
					and joins when it clicks; addresses that bounced, complained or unsubscribed stay out; throwaway and misspelled addresses are refused; and
					a visitor can sign up 5 times in 10 minutes. Anyone can post to a form, which is what makes it embeddable, so the address sets and reads no
					cookie and answers every origin without credentials. The protection is the confirmation email, the honeypot and the limits, not who posted.
				</p>
				<p className="mt-4">
					A form&apos;s page can be framed by any site; no other page of a newsletter can. Contacts made through a form have the source{" "}
					<Code>form:&lt;id&gt;</Code>, with the page that holds the form as their referrer.
				</p>
			</Section>

			<Section title="Views, signups and conversion" stagger={3}>
				<p>
					A form counts its views when its page loads, on the server, so there is no script of ours on the site that shows it. Crawlers and link
					previews don&apos;t count, and a visitor loading it over and over stops counting after 60 loads in 10 minutes. Counts are kept as one row
					for each form and day (UTC), not one per view. Signups are new contacts, pending ones included; conversion is signups over views.{" "}
					<Code>get_form</Code> has the days.
				</p>
			</Section>

			<Section title="The website's pop-up" stagger={4}>
				<p>
					A newsletter&apos;s website shows a signup form over an issue. Set when on the{" "}
					<Link href="/forms/popup" className="font-medium text-link underline decoration-link/30 underline-offset-4 hover:decoration-link">
						Pop-up page
					</Link>{" "}
					or with <Code>update_popup_settings</Code>: after some seconds ({POPUP_LIMITS.seconds.min} to {POPUP_LIMITS.seconds.max}), once the reader is a share of the
					way down the page ({POPUP_DEFAULTS.scrollPercent}% unless you change it), or when the mouse leaves through the top of the window, on desktop only;
					and on issue pages, the front page, or those and the author&apos;s page. Closing it keeps it away for {POPUP_DEFAULTS.frequencyDays} days unless you set
					another number. That, and whether the reader already signed up in their browser, are flags in the browser&apos;s own storage: no cookie, and nothing
					is sent to us. It never opens for someone who signed up there or is signed in to the website. It opens in a dialog that traps the keyboard focus,
					closes with Escape and doesn&apos;t animate for readers who ask for less motion.
				</p>
				<p className="mt-4">
					<strong className="font-medium text-foreground">Gating issues.</strong> Turn on the gate to show every issue but the newest few (1 by default) as
					its first part of the text (30% by default, plain text) followed by the signup form. A subscriber who is signed in to the website reads it whole: a
					reader signs in through the link in the email we send them when they confirm their address, or through &quot;Already subscribed? Email me a link&quot; on the issue.
					The sign-in works once, for 30 minutes, and then the browser keeps a session for 30 days. The website&apos;s RSS feed carries the same beginning with a link,
					and a paid issue keeps its own teaser. The gate hides text from search engines and readers who haven&apos;t subscribed; it is not a login for secrets.
				</p>
			</Section>

			<Section title="Magic Links" stagger={5}>
				<p>
					A Magic Link is one address that subscribes a reader in one click, from a link in <em>another</em> newsletter or in an automation. The
					other platform fills in each reader&apos;s email address when it sends, so the reader doesn&apos;t type anything. Get yours from the Forms
					page, under Magic Links, or with <Code>get_magic_link</Code>: it has <Code>{"{{email}}"}</Code> where the address goes.
				</p>
				<p className="mt-4">
					<strong className="font-medium text-foreground">In another newsletter.</strong> Ask the newsletter you swap with to use it as a button or link
					in their issue, and to put their platform&apos;s own merge tag for the reader&apos;s email address where <Code>{"{{email}}"}</Code> stands: Mailchimp&apos;s is{" "}
					<Code>*|EMAIL|*</Code>, Kit&apos;s <Code>{"{{ subscriber.email_address }}"}</Code>, FlockStack&apos;s <Code>{"{{email}}"}</Code>. Add{" "}
					<Code>utm_source</Code> and <Code>utm_campaign</Code> to see which swap brought whom. A <Code>+</Code> that their platform doesn&apos;t encode still
					reaches us as the address.
				</p>
				<BlockCode title="A swap with a Mailchimp newsletter" className="mt-3" code={MAGIC} />
				<p className="mt-4">
					<strong className="font-medium text-foreground">In an automation.</strong> Any email you send from another tool, such as a thank-you after a
					purchase or a webinar reminder, can carry the link with that tool&apos;s merge tag. Tools that call the API can use <Code>add_contact</Code> instead,
					which tells you what happened.
				</p>
				<p className="mt-4">
					<strong className="font-medium text-foreground">What keeps it safe.</strong> The link is signed for your newsletter and a key id, not for an
					address, because the other platform writes the address. That means anyone who has the link could try an address that never asked. So with
					confirmed opt-in on, which is the default, the address only gets your confirmation email and joins when it clicks it. An address can be tried{" "}
					{MAGIC_PER_EMAIL.limit} times a day and a network {MAGIC_PER_IP.limit} times in 10 minutes, on top of the signup limit of 5 in 10 minutes. A reader
					who unsubscribed is never brought back by it, only by signing up on your website. The page opens without subscribing anyone until a
					browser runs it, so link scanners don&apos;t subscribe readers who never clicked. If the link ends up where it shouldn&apos;t, retire it: the old one stops
					working at once and you get a new one. With confirmed opt-in off, anyone with the link can subscribe any address, and the dashboard warns you.
				</p>
			</Section>

			<Section title="Where signups come from" stagger={6}>
				<p>
					Each new contact keeps where it came from: the UTM parameters of the address the visitor arrived by (<Code>utm_source</Code>,{" "}
					<Code>utm_medium</Code>, <Code>utm_campaign</Code>, <Code>utm_term</Code>, <Code>utm_content</Code>), the host of the page that linked to the
					form, and a channel FlockStack works out: direct, search, social, email, paid, another website, a recommendation or your referral program.
					The newsletter&apos;s website holds the parameters in the browser&apos;s own storage for 30 days, so a reader can look around before signing up; the
					first signup&apos;s attribution is the one kept. A form in a frame gets the UTM parameters of the page that holds it.
				</p>
				<p className="mt-4">
					A signup form of your own can pass <Code>utm</Code> and <Code>referrer</Code> to <Code>add_contact</Code>. A newsletter can also add{" "}
					<Code>utm_source</Code> (its name), <Code>utm_medium=email</Code> and <Code>utm_campaign</Code> (the issue&apos;s slug) to the links in its issues
					that lead to other sites: turn on UTM tags on links in the newsletter&apos;s settings. A link that already has UTM parameters keeps them.
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
