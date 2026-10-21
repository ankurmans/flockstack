import Link from "next/link";
import BlockCode from "@/components/BlockCode";
import HeaderDocs from "@/components/HeaderDocs";
import { API_BASE_PATH } from "@/lib/api/rest";
import { getDocsPageMetadata } from "@/lib/docs/pages";
import { formatNumber } from "@/lib/format";
import { FREE_PLAN, PLANS } from "@/lib/plans";
import { MAX_IMAGES_PER_IMPORT, MAX_IMPORT_FILE_BYTES } from "@/lib/post-import-report";
import { MAX_REDIRECTS_PER_NEWSLETTER, MAX_REDIRECT_CSV_ROWS } from "@/lib/redirect-paths";

export const metadata = getDocsPageMetadata("/docs/moving");

const MB = 1024 * 1024;
const GB = 1024 ** 3;
const LINK = "font-medium text-link underline decoration-link/30 underline-offset-4 hover:decoration-link";

const EXPORTS = [
	{
		name: "Substack",
		steps: "In Settings, under Import/Export, start a new one. Substack emails a ZIP: upload the whole ZIP as it is, where posts.csv lists the posts and the posts folder has their text.",
		path: "/p/<slug>",
	},
	{
		name: "beehiiv",
		steps: "In Settings, open Export Data and start the one for posts. Its download link lasts 24 hours. Upload the CSV.",
		path: "/p/<slug>",
	},
	{
		name: "WordPress",
		steps: "In Tools, open Export, pick Posts and download the file. Upload the XML file.",
		path: "the post's permalink, like /2023/05/12/hello-world/",
	},
	{
		name: "Ghost",
		steps: "In Settings, open Import/Export (Labs on older versions) and download your content. Upload the JSON file, and give your site's address so its pictures come along.",
		path: "/<slug>/",
	},
];

const START = `curl -X POST $FLOCKSTACK_URL${API_BASE_PATH}/post-imports \\
  -H "Authorization: Bearer $FLOCKSTACK_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"url": "https://example.com/substack-export.zip"}'

curl -X POST $FLOCKSTACK_URL${API_BASE_PATH}/post-imports/<id>/start \\
  -H "Authorization: Bearer $FLOCKSTACK_API_KEY"`;

const CSV = `from,to
/p/old-post,/p/new-post
/2023/05/12/hello-world/,/p/hello-world
/about,https://example.com/about`;

export default function MovingPage() {
	return (
		<>
			<HeaderDocs kicker="Guides" title="Moving from Substack, beehiiv, WordPress or Ghost">
				Bring your archive with you: every published post becomes an issue on your FlockStack website, on its original date, and the old
				links keep working. Nothing is emailed to your readers.
			</HeaderDocs>

			<Section title="1. Download your posts" stagger={1}>
				<div className="overflow-hidden rounded-xl shadow-border">
					<table className="w-full text-left text-sm">
						<thead>
							<tr className="border-b border-border/60 text-xs text-muted-foreground">
								<th className="py-2 pl-4 font-normal">From</th>
								<th className="py-2 pr-4 font-normal">Where to find it</th>
							</tr>
						</thead>
						<tbody className="divide-y divide-border/60 align-top">
							{EXPORTS.map(({ name, steps }) => (
								<tr key={name}>
									<td className="py-3 pr-4 pl-4 font-medium whitespace-nowrap">{name}</td>
									<td className="py-3 pr-4 text-muted-foreground">{steps}</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
				<p className="mt-4">
					Files up to {MAX_IMPORT_FILE_BYTES / MB} MB are read. A ZIP with one of these files inside works too.
				</p>
			</Section>

			<Section title="2. Import them" stagger={2}>
				<p>
					In the dashboard, open{" "}
					<Link href="/newsletters/import" className={LINK}>
						Settings, then Import posts
					</Link>
					, pick the file and press Read the file. You see how many published posts it has, how many are for paid subscribers and the
					newest titles. Nothing is imported until you press Import. It runs in the background: you can close the page, and we email you
					the report.
				</p>
				<p className="mt-4">
					From the REST API or MCP, <Code>create_post_import</Code> reads the file (as base64 under 10 MB, or an https:// link) and
					answers with the preview, <Code>start_post_import</Code> starts it and <Code>get_post_import</Code> follows it.
				</p>
				<BlockCode title="Terminal" className="mt-4" code={START} />
			</Section>

			<Section title="What moves" stagger={3}>
				<ul className="list-disc space-y-2 pl-5">
					<li>
						Each published post becomes an issue already sent on its original date, listed on your website. No email goes out and nothing
						counts toward your month&apos;s emails; its stats stay at zero.
					</li>
					<li>
						Its title, its subtitle or excerpt (the preview text), its address&apos;s slug and its author. Slugs are unique across FlockStack,
						so a slug someone else has gets a number at the end, and its old address redirects there. An author who isn&apos;t your
						newsletter&apos;s keeps their name on the issue.
					</li>
					<li>
						The text, cleaned like the editor&apos;s: headings, paragraphs, lists, quotes, links, tables and pictures stay; the old
						platform&apos;s styles, scripts, signup forms and placeholders go.
					</li>
					<li>
						Pictures are copied to FlockStack&apos;s CDN, 4 MB each at most and {formatNumber(MAX_IMAGES_PER_IMPORT)} per import. One that
						can&apos;t be fetched keeps its old address and is counted in the report.
					</li>
					<li>
						Posts for paid subscribers become issues for your paid readers: the website shows a teaser. Set up your{" "}
						<Link href="/docs/selling" className={LINK}>
							paid subscription
						</Link>{" "}
						so readers can subscribe to read them.
					</li>
				</ul>
			</Section>

			<Section title="What doesn't" stagger={4}>
				<ul className="list-disc space-y-2 pl-5">
					<li>
						Subscribers: download them from the old platform and use the contact import on the Contacts page, one CSV file at a time (unzip an archive first). It
						recognizes the column names that the exports of Substack, beehiiv, Mailchimp, Kit, MailerLite, Buttondown, Ghost and EmailOctopus use, with each reader&apos;s status and signup date, so the file needs no editing. Those
						names come from each platform&apos;s own documentation or open-source migration tools, not from a live export of every platform: import a few rows first. From the API, <Code>import_contacts</Code>{" "}
						takes the rows as JSON, 1,000 a call, and reads no file.
					</li>
					<li>Paid subscriptions: they are not moved. FlockStack can&apos;t attach a subscription that exists on another platform to a contact, so a reader who pays there subscribes again.</li>
					<li>Drafts, pages, podcasts and their audio, comments, tags, and embedded videos, polls and posts, which keep only their text or link.</li>
				</ul>
			</Section>

			<Section title="Limits" stagger={5}>
				<p>
					On FlockStack Cloud each plan caps the new posts one import adds, the newest first, and what the pictures of all your imports may
					weigh together. Posts past the cap are counted in the report. A self-hosted server has no caps.
				</p>
				<div className="mt-4 overflow-hidden rounded-xl shadow-border">
					<table className="w-full text-left text-sm">
						<thead>
							<tr className="border-b border-border/60 text-xs text-muted-foreground">
								<th className="py-2 pl-4 font-normal">Plan</th>
								<th className="py-2 pr-4 font-normal">Posts per import</th>
								<th className="py-2 pr-4 font-normal">Imported pictures</th>
							</tr>
						</thead>
						<tbody className="divide-y divide-border/60">
							{[FREE_PLAN, ...PLANS].map((plan) => (
								<tr key={plan.id}>
									<td className="py-3 pr-4 pl-4 font-medium">{plan.name}</td>
									<td className="py-3 pr-4 text-muted-foreground tabular-nums">{formatNumber(plan.importPosts)}</td>
									<td className="py-3 pr-4 text-muted-foreground tabular-nums">{plan.importImageBytes < GB ? `${formatNumber(plan.importImageBytes / MB)} MB` : `${formatNumber(plan.importImageBytes / GB)} GB`}</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
				<p className="mt-4">
					Importing the same file again is safe: posts you already imported are skipped, so it only adds what is missing.
				</p>
			</Section>

			<Section id="redirects" title="Keep your old links" stagger={6}>
				<p>
					Each imported post gets a redirect from its old address ({EXPORTS.map(({ name, path }) => `${name}: ${path}`).join("; ")}) to its
					new page. They work once the old address points at FlockStack:
				</p>
				<ol className="mt-4 list-decimal space-y-2 pl-5">
					<li>
						On the{" "}
						<Link href="/domains" className={LINK}>
							Domains page
						</Link>
						, add your domain, and as the website&apos;s address enter the one your old site used, like news.example.com.
					</li>
					<li>
						At your DNS provider, change that name&apos;s record to the CNAME the Domains page shows, in place of the one that pointed at
						Substack, beehiiv, WordPress or Ghost. Remove any A or AAAA records on the same name.
					</li>
					<li>
						Press Check on the Domains page. Once it&apos;s verified, your website answers on that address and every old link lands on
						its issue with a permanent redirect (301), which search engines follow.
					</li>
				</ol>
				<p className="mt-4">
					Addresses the old platform owns, like yourname.substack.com, can&apos;t point anywhere else, and a site at the root of a domain
					(example.com) can&apos;t point at FlockStack: their old links stay with the old platform.
				</p>
				<p className="mt-4">
					Add your own redirects in Settings, under Redirects, one at a time or as a CSV of from,to rows ({formatNumber(MAX_REDIRECT_CSV_ROWS)} a
					file), or with <Code>add_redirect</Code> and <Code>import_redirects</Code>. A path matches without case, query or trailing slash, and
					a redirect keeps the visitor&apos;s query string. Your website&apos;s own pages (/, /feed.xml, /shop, /subscribe) can&apos;t
					redirect. A website has {formatNumber(MAX_REDIRECTS_PER_NEWSLETTER)} redirects at most, and a change shows within a minute.
				</p>
				<BlockCode title="redirects.csv" className="mt-4" code={CSV} />
			</Section>
		</>
	);
}

function Section({ id, title, stagger, children }) {
	return (
		<section id={id} style={{ "--stagger": stagger }} className="mt-12 max-w-3xl scroll-mt-24 animate-enter first-of-type:mt-0">
			<h2 className="mb-3 text-xl font-semibold tracking-tight">{title}</h2>
			<div className="text-[15px] leading-7 text-pretty text-foreground/80">{children}</div>
		</section>
	);
}

function Code({ children }) {
	return <code className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[13px] text-foreground">{children}</code>;
}
