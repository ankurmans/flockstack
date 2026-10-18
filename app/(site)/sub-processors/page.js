import LayoutLegal from "@/components/LayoutLegal";
import LinkInline from "@/components/LinkInline";
import SectionLegal from "@/components/SectionLegal";
import { LEGAL_PAGES, OPERATOR_DESCRIPTION, OPTIONAL_SERVICES_IN_USE, PRIVACY_EMAIL, SUBPROCESSOR_CHANGE_NOTICE } from "@/lib/legal";
import { REGION_NAMES } from "@/lib/region";
import { getPageMetadata } from "@/lib/site";
import { OPTIONAL_SUBPROCESSORS, SUBPROCESSORS } from "@/lib/subprocessors";

const { title, description, href } = LEGAL_PAGES.find((page) => page.href === "/sub-processors");
export const metadata = getPageMetadata({ title, description, path: href });

export default function SubProcessorsPage() {
	return (
		<LayoutLegal
			title="Sub-processors"
			current={href}
			intro="The services FlockStack Cloud uses that can touch personal data, what each is for and where it runs in each region."
		>
			<SectionLegal id="services" title="Services we use">
				<p>
					Your data is stored in the region you chose when you signed up. We say stored in the EU for the European Union region, and no more:
					the code runs close to the visitor, and logs and billing are not limited to it. <LinkInline href="/docs/regions">The regions page</LinkInline>{" "}
					has the full list. Subscribers&apos; emails are sent by Amazon SES in the region of the creator&apos;s account.
				</p>
				<TableServices rows={SUBPROCESSORS} />
			</SectionLegal>

			<SectionLegal id="optional" title="Optional services">
				<p>These are off unless the person running the server sets them up.</p>
				<TableServices rows={OPTIONAL_SUBPROCESSORS} />
				<p>{OPTIONAL_SERVICES_IN_USE}</p>
			</SectionLegal>

			<SectionLegal id="not-listed" title="Who isn't on this list">
				<p>
					Readers&apos; own mailbox providers receive the emails you send, and are not our sub-processors. A creator&apos;s own Stripe account,
					domain name provider and website are theirs.
				</p>
			</SectionLegal>

			<SectionLegal id="changes" title="Changes">
				<p>{SUBPROCESSOR_CHANGE_NOTICE}</p>
			</SectionLegal>

			<SectionLegal id="data-processing" title="Data processing">
				<p>
					For the personal data of a creator&apos;s subscribers, the creator is the controller and {OPERATOR_DESCRIPTION} is the processor. We
					process it only to run the newsletter on the creator&apos;s instructions, which are what they do in the dashboard, the API and MCP. We
					use the services above to do that, keep the data in the region the creator chose as described on this page, help creators answer
					their subscribers&apos; requests (the export, deleting contacts and deleting the account are in the product), and delete the data
					when the account is deleted, as the <LinkInline href="/privacy#retention">privacy policy</LinkInline> says.
				</p>
				<p>
					We offer a data processing agreement (DPA) on request. Write to <LinkInline href={`mailto:${PRIVACY_EMAIL}`}>{PRIVACY_EMAIL}</LinkInline>.
					The <LinkInline href="/terms">terms</LinkInline> and the <LinkInline href="/privacy">privacy policy</LinkInline> cover the rest.
				</p>
			</SectionLegal>
		</LayoutLegal>
	);
}

function TableServices({ rows }) {
	return (
		<div className="overflow-x-auto rounded-xl shadow-border">
			<table className="w-full min-w-[44rem] text-left text-sm">
				<thead>
					<tr className="border-b border-border/60 text-xs text-muted-foreground">
						<th className="py-2 pl-4 font-normal">Service</th>
						<th className="py-2 pr-4 font-normal">What it does</th>
						<th className="py-2 pr-4 font-normal">Data it can touch</th>
						<th className="py-2 pr-4 font-normal">{REGION_NAMES.us}</th>
						<th className="py-2 pr-4 font-normal">{REGION_NAMES.eu}</th>
					</tr>
				</thead>
				<tbody className="divide-y divide-border/60 align-top">
					{rows.map(({ name, link, purpose, data, us, eu }) => (
						<tr key={name}>
							<td className="py-3 pr-4 pl-4 font-medium">
								<LinkInline href={link}>{name}</LinkInline>
							</td>
							<td className="py-3 pr-4 text-muted-foreground">{purpose}</td>
							<td className="py-3 pr-4 text-muted-foreground">{data}</td>
							<td className="py-3 pr-4 text-muted-foreground">{us}</td>
							<td className="py-3 pr-4 text-muted-foreground">{eu}</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}
