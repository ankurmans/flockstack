import Link from "next/link";
import BlockCode from "@/components/BlockCode";
import HeaderDocs from "@/components/HeaderDocs";
import { EXPORT_LINK_DAYS } from "@/lib/account-export-files";
import { EXPORT_COLUMNS } from "@/lib/contacts-csv";
import { getDocsPageMetadata } from "@/lib/docs/llms";

export const metadata = getDocsPageMetadata("/docs/export");

const TREE = `flockstack-export-2026-10-18.zip
├── README.txt
├── manifest.json
├── suppressions.csv
├── contacts/
│   └── field-notes.csv
├── campaigns/
│   └── field-notes/
│       ├── 2026-10-04-how-to-price-a-side-project.md
│       └── 2026-10-04-how-to-price-a-side-project.html
└── images/
    └── cover-1b2c3d4e5f607182.png`;

const FRONTMATTER = `---
title: "How to price a side project"
date: 2026-10-04T08:30:00.000Z
newsletter: "field-notes"
status: "sent"
archive_url: "https://field-notes.example.com/p/how-to-price-a-side-project"
preview_text: "Charge more than feels right."
slug: "how-to-price-a-side-project"
format: "rich"
id: "6650f1c2e9b1d4a012345678"
---`;

export default function ExportPage() {
	return (
		<>
			<HeaderDocs kicker="Guides" title="Export your data">
				You can leave with everything, in one click, any time. The export is never a paid feature, and it works when your account is
				blocked or paused.
			</HeaderDocs>

			<Section title="Get it" stagger={1}>
				<p>
					On the{" "}
					<Link href="/account" className="font-medium text-link underline decoration-link/30 underline-offset-4 hover:decoration-link">
						account page
					</Link>
					, press Export everything. Or call <Code>export_account_data</Code> from the REST API (<Code>POST /api/v1/account/export</Code>)
					or MCP. It is made in the background, which can take a few minutes for a large list, and the links come to the account
					owner&apos;s email. <Code>get_account_export</Code> answers with the status and, once it&apos;s ready, the links.
				</p>
				<BlockCode
					title="Terminal"
					className="mt-4"
					code={`curl -X POST $FLOCKSTACK_URL/api/v1/account/export \\\n  -H "Authorization: Bearer $FLOCKSTACK_API_KEY"`}
				/>
				<p className="mt-4">
					The links need no key and work for {EXPORT_LINK_DAYS} days; anyone who has one can download your data, so treat it like a
					password. After that the files are deleted, and a new export makes new ones. One export at a time, and one every 5 minutes. A very
					large account comes in several ZIP files, each with its own link.
				</p>
			</Section>

			<Section title="What is inside" stagger={2}>
				<BlockCode title="Folders" code={TREE} />
				<p className="mt-4">
					Everything is plain text, CSV or the original picture files. Nothing is encrypted or tied to FlockStack.
				</p>
			</Section>

			<Section title="Contacts" stagger={3}>
				<p>
					One CSV per newsletter in <Code>contacts/</Code>, with every contact whatever its status: active, pending, unsubscribed,
					bounced, complained and dormant. The columns are <Code>{EXPORT_COLUMNS.map(([name]) => name).join(", ")}</Code>. Dates are ISO 8601
					in UTC; <Code>tags</Code> are separated by <Code>;</Code>; <Code>referrals</Code> is how many people a contact brought in. The
					first columns are the ones FlockStack&apos;s own CSV import reads, so the file goes back in as it is.
				</p>
				<p className="mt-4">
					<Code>suppressions.csv</Code> lists the addresses that bounced, complained or were blocked, with the reason. Keep them off any
					list you move to.
				</p>
			</Section>

			<Section title="Issues" stagger={4}>
				<p>
					Every issue and draft is two files in <Code>campaigns/&lt;newsletter&gt;/</Code>: Markdown and a standalone HTML page, named{" "}
					<Code>date-slug</Code>. Both start with the same frontmatter, as static site generators read it.
				</p>
				<BlockCode title="Frontmatter" className="mt-4" code={FRONTMATTER} />
				<p className="mt-4">
					<Code>status</Code> is draft, scheduled, sending, paused, sent or canceled. <Code>archive_url</Code> is where the issue is
					published, when it is. Issues written in Markdown keep their Markdown; the editor&apos;s issues are turned into Markdown, and designed
					HTML issues into their text. The HTML file is the issue as the website shows it. Pictures from your library are in{" "}
					<Code>images/</Code>, and both files point to them with relative links.
				</p>
			</Section>

			<Section title="The manifest" stagger={5}>
				<p>
					<Code>manifest.json</Code> lists everything in the export: each newsletter with its settings (sender, welcome and confirmation
					emails, archive address, feed address, referral rewards, custom fields, and the newsletters it recommends by their public slug), its contact count and file, every issue with its title, date, status and
					files, every picture with its original address and whether it could be fetched, and each file&apos;s size and CRC-32. Its{" "}
					<Code>version</Code> changes only when the layout does.
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
