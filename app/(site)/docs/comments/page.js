import Link from "next/link";
import HeaderDocs from "@/components/HeaderDocs";
import { getDocsPageMetadata } from "@/lib/docs/llms";
import { COMMENT_LINK_TAG } from "@/lib/comment-tags";
import { EDIT_WINDOW_MS } from "@/lib/comment-rules";
import { MAX_COMMENT_CHARS, MAX_COMMENT_LINKS } from "@/lib/comment-body";
import { SIGNIN_MINUTES } from "@/lib/reader-links";

export const metadata = getDocsPageMetadata("/docs/comments");

export default function CommentsPage() {
	return (
		<>
			<HeaderDocs kicker="Guides" title="Comments">
				Subscribers can comment on your newsletter&apos;s web issues. They have no account and no password, other readers never see their
				email, and whatever you hold, hide or remove has a reason its author reads.
			</HeaderDocs>

			<Section title="Turn them on" stagger={1}>
				<p>
					Comments are off until you turn them on, from the{" "}
					<Link href="/comments" className="font-medium text-foreground underline decoration-foreground/30 underline-offset-4 hover:decoration-foreground">
						Comments page
					</Link>{" "}
					or with <Code>set_comment_settings</Code>. The newsletter needs its website on, since comments sit under each issue&apos;s page. You choose
					who can comment (every active subscriber, or paid subscribers only) and what waits for your review: nothing, comments with a link, or
					every comment. An issue can follow the newsletter or be set on or off by itself, which is also how you close a thread. An issue for
					paid subscribers only has a teaser page, so it has no comments.
				</p>
			</Section>

			<Section title="How subscribers sign in" stagger={2}>
				<p>
					A reader proves they are a subscriber with a signed link, not a password. The footer of an issue&apos;s email has a Discuss this issue link
					that signs them in on the issue&apos;s page, and <Code>{COMMENT_LINK_TAG}</Code> puts the same link anywhere in an issue. On the web page, Sign
					in with your email sends a one-time link to the address, through the newsletter&apos;s own sending path: it works once and for{" "}
					{SIGNIN_MINUTES} minutes, and the page it opens asks for one click so that a mail scanner can&apos;t use it up.
				</p>
				<p className="mt-4">
					The answer to that form is the same for every address, subscribed or not, so it can&apos;t be used to find out who subscribes. Only an
					active subscriber can comment: someone who unsubscribed, bounced, complained or never confirmed can&apos;t, even with a link that still
					works. The link starts a session for that newsletter only, kept in a cookie for 30 days.
				</p>
			</Section>

			<Section title="Names and privacy" stagger={3}>
				<p>
					A comment shows a display name, never an email address. It starts as the part of the address before the @ (ana.lopez becomes Ana Lopez),
					and the reader can change it once, with their first comment. You, the owner, see the address next to each comment on the Comments page.
					Everything is stored in your account&apos;s own database, in the region you chose, and nowhere else (see{" "}
					<Link href="/docs/regions" className="font-medium text-foreground underline decoration-foreground/30 underline-offset-4 hover:decoration-foreground">
						Regions
					</Link>
					). When you delete a contact, their comments stay for the replies&apos; sake as the Deleted reader&apos;s, with nothing that links them to a person.
				</p>
			</Section>

			<Section title="What a comment can be" stagger={4}>
				<p>
					Plain text, up to {MAX_COMMENT_CHARS.toLocaleString("en-US")} characters, with line breaks, web addresses and links written as{" "}
					<Code>[words](https://address)</Code>. At most {MAX_COMMENT_LINKS} links. Nothing is HTML: markup a reader types is printed as typed, and only
					http and https links work. A reader can reply to a comment, one level deep, change their own for {EDIT_WINDOW_MS / 60_000} minutes (a change
					is judged by your rules again, so adding a link to a comment under hold-links holds it), and delete it at any time. They can report a
					comment, with a reason if they like; nothing happens until you decide.
				</p>
				<p className="mt-4">
					Spam is kept down without judging anyone&apos;s words: a limit on comments per reader and per network, a hidden field that bots fill in,
					and the same words only once on an issue. What counts as acceptable is yours to say.
				</p>
			</Section>

			<Section title="Moderation, and the reason" stagger={5}>
				<ul className="list-disc space-y-1.5 pl-5 marker:text-muted-foreground">
					<li>
						<strong className="font-medium text-foreground">Held.</strong> A comment your settings hold waits on the Comments page with the reason it was held. Its
						writer sees it, marked as waiting, with the same reason.
					</li>
					<li>
						<strong className="font-medium text-foreground">Hide.</strong> Takes a comment off the page and keeps it; you can approve it again. A reason is required.
					</li>
					<li>
						<strong className="font-medium text-foreground">Remove.</strong> Takes it off the page for good, unless you approve it again. A reason is required.
					</li>
					<li>
						<strong className="font-medium text-foreground">Block a commenter.</strong> Turns commenting off for one subscriber, with a reason they read when they try. They stay
						subscribed and keep getting your emails.
					</li>
				</ul>
				<p className="mt-4">
					The author always sees the reason, on the issue&apos;s page and in an email sent the way your newsletter&apos;s other emails are (suppressed
					addresses and blocked accounts get none). Replies to a comment you hid stay on the page under a note.
				</p>
			</Section>

			<Section title="Emails" stagger={6}>
				<p>
					Nothing nags. You get one email about new comments and reports an hour at most, however many come, and you can turn it off. A reader gets one
					email when someone replies to their comment, at most three a day, with a link that turns them off. The sign-in link and the notices about a
					hidden or removed comment are the only others.
				</p>
			</Section>

			<Section title="From the API" stagger={7}>
				<p>
					<Code>list_comments</Code>, <Code>get_comment</Code>, <Code>moderate_comment</Code>, <Code>set_comment_settings</Code>,{" "}
					<Code>block_commenter</Code>, <Code>unblock_commenter</Code> and <Code>list_comment_reports</Code> work from the REST API and MCP.{" "}
					<Code>export_account_data</Code> includes each newsletter&apos;s comments as a CSV, and deleting the account deletes them.
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
