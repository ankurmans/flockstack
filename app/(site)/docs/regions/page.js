import HeaderDocs from "@/components/HeaderDocs";
import { isCloud } from "@/lib/config";
import { getDocsPageMetadata } from "@/lib/docs/llms";
import { REGION_DATA, REGION_LEAVES } from "@/lib/docs/regions";
import { REGION_NAMES, REGION_PLACES, getRegion, getRegionUrls } from "@/lib/region";

export const metadata = getDocsPageMetadata("/docs/regions");

export default function RegionsPage() {
	const urls = getRegionUrls();

	return (
		<>
			<HeaderDocs kicker="Guides" title="Regions">
				{isCloud()
					? `FlockStack Cloud runs in two regions, each with its own database and storage. You choose where your data is stored when you sign up. This server stores its data in ${REGION_PLACES[getRegion()]}.`
					: "FlockStack Cloud runs in two regions, each with its own database and storage. A server you host yourself has one place for its data, wherever you deployed it, so the rest of this page is about FlockStack Cloud."}
			</HeaderDocs>

			<Section title="Two regions, one account each" stagger={1}>
				<p>
					The {REGION_NAMES.us} deployment is <Code>{urls.us}</Code> and the {REGION_NAMES.eu} one is <Code>{urls.eu}</Code>. They run
					the same code. The sign-up and sign-in pages ask where your data should live, and start on the {REGION_NAMES.eu} for visitors
					from the EU, the other EEA countries, the UK and Switzerland.
				</p>
				<p className="mt-4">
					An account lives in exactly one region. Signing in, API keys, passkeys and connected apps work at that region&apos;s address only,
					and FlockStack doesn&apos;t look an account up in the other region or move one between them. To use both, create an account in
					each. Newsletters can recommend each other only inside a region. API keys start with <Code>mc_</Code> in the {REGION_NAMES.us} and <Code>mc_eu_</Code> in the {REGION_NAMES.eu}.
				</p>
			</Section>

			<Section title="Where each kind of data is stored" stagger={2}>
				<div className="overflow-hidden rounded-xl shadow-border">
					<table className="w-full text-left text-sm">
						<thead>
							<tr className="border-b border-border/60 text-xs text-muted-foreground">
								<th className="py-2 pl-4 font-normal">Data</th>
								<th className="py-2 pr-4 font-normal">{REGION_NAMES.us}</th>
								<th className="py-2 pr-4 font-normal">{REGION_NAMES.eu}</th>
							</tr>
						</thead>
						<tbody className="divide-y divide-border/60 align-top">
							{REGION_DATA.map(({ what, us, eu }) => (
								<tr key={what}>
									<td className="py-3 pr-4 pl-4 font-medium">{what}</td>
									<td className="py-3 pr-4 text-muted-foreground">{us}</td>
									<td className="py-3 pr-4 text-muted-foreground">{eu}</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			</Section>

			<Section title="What isn't kept in the region" stagger={3}>
				<p>
					Your data is stored in the region you chose. These are the places it, or what describes it, goes beyond it. That is why this page
					says stored in the {REGION_NAMES.eu} and not more.
				</p>
				<ul className="mt-4 flex list-disc flex-col gap-2 pl-5 marker:text-muted-foreground">
					{REGION_LEAVES.map((item) => (
						<li key={item}>{item}</li>
					))}
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
