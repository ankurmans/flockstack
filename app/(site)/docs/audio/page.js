import Link from "next/link";
import HeaderDocs from "@/components/HeaderDocs";
import { getDocsPageMetadata } from "@/lib/docs/llms";
import { AUDIO_CHUNK_CHARS, DEFAULT_AUDIO_MODEL, MAX_AUDIO_CHARACTERS } from "@/lib/audio-config";
import { estimateMinutes } from "@/lib/audio-text";
import { formatNumber } from "@/lib/format";
import { CHANGE_NOTICE_DAYS, getElevenLabsStartDate } from "@/lib/legal";
import { AUDIO_CHARACTERS_PER_MONTH, PLANS } from "@/lib/plans";

export const metadata = getDocsPageMetadata("/docs/audio");

const formatReleaseDate = (date) => new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", month: "long", day: "numeric", year: "numeric" });

const Anchor = ({ href, children }) => (
	<Link href={href} className="font-medium text-link underline decoration-link/30 underline-offset-4 hover:decoration-link">
		{children}
	</Link>
);

export default function AudioPage() {
	const start = getElevenLabsStartDate();

	return (
		<>
			<HeaderDocs kicker="Guides" title="Audio versions">
				An audio version reads an issue aloud in a voice you pick. Readers play it on the issue&apos;s page, you can open your emails with a link to
				it, and the newsletter can be a podcast.
			</HeaderDocs>

			<Section title="When it starts" stagger={1}>
				<p>
					{start
						? `On FlockStack Cloud, audio versions start on ${formatReleaseDate(start)}.`
						: `Audio versions are coming to FlockStack Cloud, and they are off until then.`}{" "}
					They need a new sub-processor, a text-to-speech service named on the sub-processors page, and the terms promise {CHANGE_NOTICE_DAYS} days&apos;
					notice by email before one starts handling data. Until it starts, the dashboard shows nothing of this and the API refuses it. A
					self-hosted server turns them on by giving the server its own voice service account and a list of voices (see the README).
				</p>
			</Section>

			<Section title="Make one" stagger={2}>
				<p>
					Open an issue, a draft or one already sent, and use the Audio version card (in the Review step of a draft, and in the report of a sent issue). Pick a
					voice, listen to its sample, and the card tells you what the audio will use of the month&apos;s characters before anything is read. Creating it
					starts a background job: you can leave the page, and the card follows it. When it is ready you hear it in the card, and the{" "}
					<Code>audio.ready</Code> webhook fires. Change the issue and create it again, and the new audio replaces the old one; if the issue didn&apos;t
					change since, nothing is read again and nothing is counted.
				</p>
				<p className="mt-4">
					A job that fails keeps what was read: it stops with a message that says which part failed, counts only the characters actually read, and
					creating it again goes on from the parts it kept. An issue can be up to {formatNumber(MAX_AUDIO_CHARACTERS)} characters, read in parts of
					{" "}{formatNumber(AUDIO_CHUNK_CHARS)} characters at most, cut between sentences.
				</p>
			</Section>

			<Section title="What is read" stagger={3}>
				<ul className="list-disc space-y-1.5 pl-5 marker:text-muted-foreground">
					<li>The issue&apos;s title first, then the text in order. Headings and list items are read as sentences, and a link is read as its words.</li>
					<li>A web address in the text is read as the site it goes to, like example.com. Footnotes are read at the end, under Notes.</li>
					<li>
						Pictures are left out. Tables, code, embeds, polls and file downloads are left out too, and then the audio ends with a line that says
						some parts are only in the web version.
					</li>
					<li>
						An issue for everyone with a paywall break is read up to the break, with a line saying the rest is for paid subscribers: the audio is
						public, and the paid part never is. An issue for paid subscribers only is read whole and played to paid readers only.
					</li>
				</ul>
			</Section>

			<Section title="Characters, by plan" stagger={4}>
				<p>
					Audio is counted by the character read, for the account, per calendar month in UTC. A plan has a number of characters a month; an
					audio version that would go past what is left is refused before it starts, with how many are left. There is no overage and nothing to buy
					on top. The Free plan has no audio. About 825 characters is a minute of speech, so the numbers below are the minutes in brackets.
				</p>
				<div className="mt-4 overflow-x-auto rounded-xl shadow-border">
					<table className="w-full min-w-[22rem] text-left text-sm tabular-nums">
						<thead>
							<tr className="border-b border-border/60 text-xs text-muted-foreground">
								<th className="py-2 pl-4 font-normal">Plan</th>
								<th className="py-2 pr-4 text-right font-normal">Characters a month</th>
							</tr>
						</thead>
						<tbody className="divide-y divide-border/60">
							{PLANS.map(({ id, name }) => (
								<tr key={id}>
									<td className="py-2 pl-4 font-medium">{name}</td>
									<td className="py-2 pr-4 text-right">
										{formatNumber(AUDIO_CHARACTERS_PER_MONTH[id])} <span className="text-muted-foreground">({formatNumber(estimateMinutes(AUDIO_CHARACTERS_PER_MONTH[id]))} min)</span>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
				<p className="mt-4">
					<Code>get_audio_usage</Code> says what the month has used and left, and, given an issue, what its audio would use.
				</p>
			</Section>

			<Section title="Listening" stagger={5}>
				<p>
					On the issue&apos;s web page the player sits above the text: play and pause, 15 seconds back and forward, speeds of 1x, 1.25x, 1.5x and 2x, and
					a slider. It remembers where you stopped in the reader&apos;s own browser (local storage) and tells nobody: nothing about listening is
					counted or sent. Tick Listen to this issue in the card and each email of the issue opens with a link to it, with the length: for example
					Listen to this issue (12 min). An issue for paid subscribers only has no public page, so it has no such link: paid readers play it on the
					page after signing in.
				</p>
			</Section>

			<Section title="The podcast" stagger={6}>
				<p>
					Turn the podcast on in the <Anchor href="/audio">Audio page</Anchor> and the newsletter&apos;s website serves an RSS 2.0 feed with the iTunes tags at{" "}
					<Code>/podcast.xml</Code>, with each issue that has audio as an episode, the newsletter&apos;s logo as cover art and the files streamed
					with byte ranges, which podcast apps and iOS need. An issue for paid subscribers only is never in it. The Audio page shows the feed address and
					how to give it to Apple Podcasts and Spotify. Apple wants cover art of at least 1400 by 1400 pixels and at least one episode.
				</p>
			</Section>

			<Section title="From the API" stagger={7}>
				<p>
					<Code>list_audio_voices</Code>, <Code>get_audio_usage</Code>, <Code>create_audio_version</Code>, <Code>get_audio_version</Code>,{" "}
					<Code>update_audio_version</Code>, <Code>delete_audio_version</Code>, <Code>get_audio_settings</Code> and <Code>update_audio_settings</Code> work
					from the REST API and MCP. An issue&apos;s ID is its audio version&apos;s ID. A voice is read in parts of {formatNumber(AUDIO_CHUNK_CHARS)}{" "}
					characters, with the voice service&apos;s <Code>{DEFAULT_AUDIO_MODEL}</Code> model unless the server sets another.
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
