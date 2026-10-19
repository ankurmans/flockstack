import Link from "next/link";
import BlockCode from "@/components/BlockCode";
import HeaderDocs from "@/components/HeaderDocs";
import { getDocsPageMetadata } from "@/lib/docs/llms";
import { SOURCE_URL } from "@/lib/site";
import { WEBHOOK_EVENTS } from "@/lib/webhook-events";

export const metadata = getDocsPageMetadata("/docs/zapier-make");

const ZAPIER_STEPS = `cd integrations/zapier
npm install
npx zapier-platform-cli login
npx zapier-platform-cli register "FlockStack"   # once: makes your private app
npx zapier-platform-cli push                    # uploads this version
npx zapier-platform-cli users:add you@example.com 1.0.0`;

export default function ZapierMakePage() {
	return (
		<>
			<HeaderDocs kicker="Guides" title="Zapier and Make">
				Connect FlockStack to thousands of apps: start a Zap or a scenario when someone subscribes, a campaign goes out or an order is paid,
				and add subscribers and tags from anywhere. Both apps are in FlockStack&apos;s repository, ready to install as a private app in your
				own Zapier or Make account.
			</HeaderDocs>

			<Section title="What they do" stagger={1}>
				<p>Triggers, one per webhook event:</p>
				<ul className="mt-3 grid gap-1 sm:grid-cols-2">
					{WEBHOOK_EVENTS.map(({ type, title }) => (
						<li key={type}>
							{title} <span className="font-mono text-[13px] text-muted-foreground">({type})</span>
						</li>
					))}
				</ul>
				<p className="mt-4">
					Actions: add a subscriber, add or update a subscriber (tags and custom fields), add a tag. Search: find a subscriber by email, or
					find or add one in a single step.
				</p>
				<p className="mt-4">
					Turning a Zap or a scenario on adds a{" "}
					<Link href="/docs/webhooks" className="text-link underline decoration-link/30 underline-offset-4 hover:decoration-link">
						webhook
					</Link>{" "}
					for its event, and turning it off deletes it, so each one uses one of your plan&apos;s webhook endpoints. You see them on the
					Webhooks page, marked zapier or make.
				</p>
			</Section>

			<Section title="Connecting" stagger={2}>
				<p>
					Both ask for a full access API key from the{" "}
					<Link href="/api-keys" className="text-link underline decoration-link/30 underline-offset-4 hover:decoration-link">
						API keys page
					</Link>{" "}
					and your region: the United States (<Code>flockstack.io</Code>) or the European Union (<Code>eu.flockstack.io</Code>). A key works
					only in its own region; European Union keys start with <Code>mc_eu_</Code>. If you host FlockStack yourself, put your server&apos;s
					address in &quot;Your own server&quot; instead.
				</p>
			</Section>

			<Section title="Install the Zapier app" stagger={3}>
				<p>
					The app is in <Code>integrations/zapier</Code> of the{" "}
					<a href={SOURCE_URL} className="text-link underline decoration-link/30 underline-offset-4 hover:decoration-link">
						repository
					</a>
					, built for the Zapier Platform CLI. With Node.js 18 or later and a Zapier account, push it as a private app and invite yourself:
				</p>
				<BlockCode title="Terminal" className="mt-4" code={ZAPIER_STEPS} />
				<p className="mt-4">
					A private app is free and only reaches the people you invite: your teammates, or the creators you run newsletters for. Open the
					invite link Zapier gives you, then pick FlockStack in any Zap. When a new version is pushed, migrate your Zaps to it from
					Zapier&apos;s developer platform.
				</p>
			</Section>

			<Section title="Install the Make app" stagger={4}>
				<p>
					The app is in <Code>integrations/make</Code>: a Make custom app with its connection, a dedicated webhook, the trigger, three actions,
					the search and the newsletters list. <Code>makecomapp.json</Code> maps each component to its files.
				</p>
				<ol className="mt-3 flex list-decimal flex-col gap-2 pl-5">
					<li>
						In Make, open <span className="font-medium">Custom apps</span> and create an app named FlockStack.
					</li>
					<li>
						Install the Make Apps Editor extension for Visual Studio Code, add your Make API key to it, and open the{" "}
						<Code>integrations/make</Code> folder: it deploys every file to the app. Or paste each file into the matching block of the app in
						Make&apos;s own editor: Base, Connection, Webhook (attach and detach), each module&apos;s Communication, Mappable parameters and
						Interface, and the remote procedure.
					</li>
					<li>The app stays private to your Make organization. Share it with an invite link from its page to use it in another one.</li>
				</ol>
			</Section>

			<Section title="Good to know" stagger={5}>
				<ul className="flex flex-col gap-2">
					<li>
						Add or update a subscriber signs someone up when the address isn&apos;t subscribed yet, with the newsletter&apos;s usual welcome or
						confirmation email. It never brings back someone who unsubscribed; Add a subscriber does when you turn on &quot;Bring back if
						unsubscribed&quot;, which is only for people who asked.
					</li>
					<li>Contacts added by an import send no events, so an import doesn&apos;t start a Zap for each row.</li>
					<li>
						Events are retried for about 5 days, and an endpoint that fails all that time is turned off: a Zap that was deleted on Zapier&apos;s
						side cleans itself up.
					</li>
				</ul>
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
