import BlockCode from "@/components/BlockCode";
import HeaderDocs from "@/components/HeaderDocs";
import { MAX_SECTIONS, MAX_SECTION_ITEMS } from "@/lib/briefing-rules";
import { getDocsPageMetadata } from "@/lib/docs/pages";

export const metadata = getDocsPageMetadata("/docs/briefings");

const EXAMPLE = `{
  "sections": [
    { "id": "lead", "title": "Lead", "format": "sentences", "maxItems": 1, "budgetShare": 30, "priority": 1,
      "purpose": "The day's most important story, with its numbers" },
    { "id": "deals", "title": "Deals", "format": "one-liners", "maxItems": 8, "budgetShare": 40, "priority": 2,
      "purpose": "Acquisitions and funding rounds, each with the amount" },
    { "id": "people", "title": "People moves", "format": "one-liners", "maxItems": 5,
      "purpose": "Executive hires and departures, with the person, role and company" }
  ]
}`;

export default function BriefingsDocsPage() {
	return (
		<>
			<HeaderDocs kicker="Guides" title="Briefings">
				A briefing searches the web for your topic on a schedule, picks the stories your readers care about, reads the original pages and
				writes a short issue with every story linked to its source. Each issue waits as a draft for your review: a briefing never sends by
				itself.
			</HeaderDocs>

			<Section title="The brief" stagger={1}>
				<p>
					There is no list of sources to keep up. You describe the topic, who reads about it and what makes a story useful to them, and can
					add up to 10 example stories you would have wanted. Trusted outlets add to a story&apos;s score and have their feeds read on each
					run; blocked hosts are never read. Discovery uses free news indexes, and your own search key when you add one.
				</p>
			</Section>

			<Section title="Your own keys and the budget" stagger={2}>
				<p>
					Each step (queries, triage, extract, write, check, translate) runs on a model of your own AI key, added on the AI keys page, so the
					model cost is yours. A key is encrypted when you save it and is never shown again. Every run has a budget in USD, 0.25 by default,
					shared between the steps; a call that would pass it isn&apos;t made. The owner&apos;s note after each run says what it cost.
				</p>
			</Section>

			<Section title="Sections" stagger={3}>
				<p>
					Without sections, an issue is full stories (a paragraph or two each) followed by one-line items. With sections, the issue is a
					labelled skeleton you set once: up to {MAX_SECTIONS} sections in reading order, each with a title, what belongs in it, a format and
					the most stories it holds (up to {MAX_SECTION_ITEMS}).
				</p>
				<ul className="mt-4 list-disc pl-5">
					<li>Each story is put in the section whose purpose it fits best, or in none. A section never holds more than its most stories.</li>
					<li>
						<Code>sentences</Code> gives each story a sentence or two with its numbers; <Code>one-liners</Code> gives each one sourced line.
					</li>
					<li>
						A budget share is a section&apos;s percent of the extract and write steps&apos; budget. The shares you give add up to 100 at most; with
						none, the budget is split evenly between the sections.
					</li>
					<li>
						When the budget runs short, sections with a lower priority number are written first (1 first); without priorities, the reading
						order decides. A section that runs out of its share is skipped and the note says so.
					</li>
					<li>A section with no story is left out of the issue, and the note lists it as empty.</li>
					<li>Each section is a heading of the issue. A translated version keeps the same sections, translated.</li>
				</ul>
				<p className="mt-4">
					Set them on the briefing&apos;s page in the dashboard, or with <Code>update_briefing</Code>. Sending the list replaces it, and{" "}
					<Code>[]</Code> goes back to full stories then one-line items.
				</p>
				<BlockCode title="update_briefing" className="mt-4" code={EXAMPLE} />
				<p className="mt-4">
					Each run lists its sections with their status (written, empty, skipped for the budget, or failed), how many stories each holds and
					what each cost (<Code>get_briefing_run</Code>, and the run&apos;s page).
				</p>
			</Section>

			<Section title="Review, keep and drop" stagger={4}>
				<p>
					Every run makes a draft campaign, sends a test email of it to your test address, and sends you a separate note with its checks, its
					cost and a keep or drop link per story. Keeping and dropping teaches the briefing what you want: later runs pick more stories like
					the kept ones. Each link opens a page that asks before it records anything.
				</p>
				<p className="mt-4">
					The pages a briefing reads are fetched by FlockStack-Briefings, which obeys robots.txt: see{" "}
					<a href="/docs/briefings-bot" className="text-link hover:underline">
						the FlockStack-Briefings fetcher
					</a>
					.
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
