import { redirect } from "next/navigation";
import BlockCode from "@/components/BlockCode";
import FormMagicLink from "@/components/FormMagicLink";
import HeaderPage from "@/components/HeaderPage";
import { runDashboardAction } from "@/lib/actions/dashboard";
import { ADD_NEWSLETTER_PATH } from "@/lib/newsletters";
import { getSelectedNewsletter } from "@/lib/selected-newsletter";

export const metadata = { title: "Magic Links" };

// Platforms' own merge tags for the reader's address, to put where {{email}} stands.
const MERGE_TAGS = [
	["FlockStack", "{{email}}"],
	["Mailchimp", "*|EMAIL|*"],
	["Kit", "{{ subscriber.email_address }}"],
];

export default async function MagicLinksPage() {
	const { selected } = await getSelectedNewsletter();
	if (!selected) redirect(ADD_NEWSLETTER_PATH);
	const { output } = await runDashboardAction("get_magic_link", { id: String(selected._id) });

	return (
		<>
			<HeaderPage title="Magic Links" />
			<div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
				<p className="text-sm text-pretty text-muted-foreground">
					Give this link to another newsletter, or use it in an automation: it subscribes the reader in one click, from an address their platform fills in. With confirmed opt-in on, they still get your confirmation email and join when they click it.
				</p>
				{output && (
					<>
						<BlockCode title="Magic Link" code={output.template} />
						{output.warning && (
							<p role="alert" className="rounded-xl bg-amber-50 p-4 text-sm text-pretty text-amber-950 ring-1 ring-amber-500/30 dark:bg-amber-500/10 dark:text-amber-50">
								{output.warning}
							</p>
						)}
						<section className="rounded-xl bg-card p-4 text-sm shadow-border">
							<h2 className="font-medium">Where the reader&apos;s email goes</h2>
							<p className="mt-1 text-muted-foreground">
								Replace <code className="font-mono text-foreground">{"{{email}}"}</code> with the platform&apos;s own merge tag for the reader&apos;s address. Add{" "}
								<code className="font-mono text-foreground">&amp;utm_source=their-newsletter</code> and <code className="font-mono text-foreground">&amp;utm_campaign=…</code> to see them in your reports.
							</p>
							<ul className="mt-3 flex flex-col gap-1 text-muted-foreground">
								{MERGE_TAGS.map(([name, tag]) => (
									<li key={name}>
										{name}: <code className="font-mono text-foreground">{tag}</code>
									</li>
								))}
							</ul>
						</section>
						<FormMagicLink newsletterId={String(selected._id)} keyId={output.keyId} />
					</>
				)}
			</div>
		</>
	);
}
