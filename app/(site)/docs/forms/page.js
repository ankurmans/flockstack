import Link from "next/link";
import BlockCode from "@/components/BlockCode";
import HeaderDocs from "@/components/HeaderDocs";
import { getDocsPageMetadata } from "@/lib/docs/llms";
import { MAX_FORMS_PER_NEWSLETTER, MAX_FORM_FIELDS } from "@/lib/form-rules";

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

export default function FormsPage() {
	return (
		<>
			<HeaderDocs kicker="Guides" title="Forms, pop-ups and Magic Links">
				Put a signup form on any site, see how each one does, and keep track of where every subscriber came from.
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

			<Section title="Where signups come from" stagger={4}>
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
