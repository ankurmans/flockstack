import { getReaderText } from "@/lib/reader-languages";
import { notFound } from "next/navigation";
import AvatarNewsletter from "@/components/AvatarNewsletter";
import BadgeDate from "@/components/BadgeDate";
import BadgeViews from "@/components/BadgeViews";
import CardIssue from "@/components/CardIssue";
import BodyIssue from "@/components/BodyIssue";
import ChipsTag from "@/components/ChipsTag";
import GateIssue from "@/components/GateIssue";
import LinksShare from "@/components/LinksShare";
import ListRecommendations from "@/components/ListRecommendations";
import PitchSubscribe from "@/components/PitchSubscribe";
import SectionComments from "@/components/SectionComments";
import ScriptJsonLd from "@/components/ScriptJsonLd";
import TrackView from "@/components/TrackView";
import TriggerSubscribe from "@/components/TriggerSubscribe";
import { getIssueAuthor } from "@/lib/archive-author";
import { getIssueAudio } from "@/lib/audio";
import { isAudioEnabled } from "@/lib/audio-config";
import { renderPageBody } from "@/lib/archive-content";
import { countReaders, getArchiveIssue, getArchiveNewsletter, getArchivePage, getShopPayments, listArchiveIssues, listSignupFields } from "@/lib/archive-data";
import { getGatePreview, listFreeIssueIds } from "@/lib/archive-gate";
import { getArchiveUrls } from "@/lib/archive-hosts";
import { getBrand } from "@/lib/brand";
import { getPopupSettings, getTriggerProps, isGatedIssue, isPopupOn } from "@/lib/popup-rules";
import { getIssueDate } from "@/lib/archive-issues";
import { getCustomJsonLd, getIssueJsonLd, getIssueSeo, getPageSeo, getPrivateSeo } from "@/lib/archive-seo";
import { getTagSlug } from "@/lib/issue-tags";
import { renderWebIssue } from "@/lib/web-issue";
import { hasRecommendationsTag } from "@/lib/recommendation-tags";
import { listLiveRecommendations } from "@/lib/recommendations";
import { areCommentsOn, getCommentSettings } from "@/lib/comment-rules";
import { listPublicComments } from "@/lib/comments";
import { cn } from "@/lib/utils";

export const revalidate = 3600;

export function generateStaticParams() {
	return [];
}

// /p/<slug> is an issue or, when no issue has the slug, one of the newsletter's custom pages. The two never share a slug
// within a newsletter (lib/archive-slugs.js, lib/actions/website.js), so the order only decides the rare old collision: the issue keeps the address.
async function getPost(params) {
	const { slug, post } = await params;
	const newsletter = await getArchiveNewsletter(slug);
	if (!newsletter) return null;
	const issue = await getArchiveIssue(newsletter, post);
	if (issue) return { newsletter, issue };
	const page = await getArchivePage(newsletter, post);
	return page ? { newsletter, page } : null;
}

export async function generateMetadata({ params }) {
	const post = await getPost(params);
	if (!post) return {};
	if (post.issue) return post.newsletter.privateArchive ? getPrivateSeo(post.newsletter) : getIssueSeo(post.newsletter, post.issue).metadata;
	return getPageSeo(post.newsletter, post.page).metadata;
}

export default async function PostPage({ params }) {
	const post = await getPost(params);
	if (!post) notFound();
	// Called, not rendered as components, so the page's output is the finished tree.
	return post.issue ? await renderIssue(post) : await renderPage(post);
}

async function renderPage({ newsletter, page }) {
	const [readers, signupFields] = await Promise.all([countReaders(newsletter), listSignupFields(newsletter)]);
	const pitch = {
		language: newsletter.language ?? "en", readerTranslations: Boolean(newsletter.readerTranslations), name: newsletter.name, slug: newsletter.slug, imageUrl: newsletter.imageUrl, description: newsletter.description, signupFields };
	// Its own pages (About, Sponsor) carry the pop-up like issues do.
	const popup = getPopupSettings(newsletter);

	return (
		<>
			<ScriptJsonLd data={getPageSeo(newsletter, page).jsonLd} />
			<article className="mx-auto max-w-2xl px-5 pt-12 sm:pt-16">
				<h1 className="site-title text-4xl font-semibold tracking-tight text-balance animate-enter sm:text-[2.75rem] sm:leading-[1.1]">{page.title}</h1>
				<div
					style={{ "--stagger": 1 }}
					className="prose-issue mt-10 animate-enter"
					dangerouslySetInnerHTML={{ __html: renderPageBody(page.html, { accent: getBrand(newsletter).accent, contentsLabel: getReaderText(newsletter)("Contents") }) }}
				/>
			</article>
			<section id="subscribe" className="mx-auto max-w-2xl scroll-mt-24 px-5 pt-16 pb-24">
				<div className="rounded-2xl bg-card px-6 py-10 shadow-border sm:px-10">
					<PitchSubscribe newsletter={pitch} readers={readers} />
				</div>
			</section>
			{isPopupOn(popup, "issue") && <TriggerSubscribe newsletterSlug={newsletter.slug} {...getTriggerProps(popup)} />}
		</>
	);
}

// A private website's issue page is the same for everyone: no title, no text, only the gate. The reader's browser asks for the
// issue (lib/reader-access.js), and gets it if a signed-in subscriber is behind it.
async function renderPrivateIssue({ newsletter, issue }) {
	const [signupFields] = await Promise.all([listSignupFields(newsletter)]);
	const pitch = { language: newsletter.language ?? "en", readerTranslations: Boolean(newsletter.readerTranslations), name: newsletter.name, slug: newsletter.slug, imageUrl: newsletter.imageUrl, description: newsletter.description, signupFields };
	return (
		<article className="mx-auto max-w-2xl px-5 pt-12 sm:pt-16">
			<GateIssue preview="" newsletter={pitch} post={issue.archiveSlug} subscribeHref={null} isPrivate />
		</article>
	);
}

async function renderIssue({ newsletter, issue }) {
	if (newsletter.privateArchive) return renderPrivateIssue({ newsletter, issue });

	const hasComments = areCommentsOn(newsletter, issue);
	const [more, readers, payments, signupFields, recommendations, comments, audio] = await Promise.all([
		listArchiveIssues(newsletter, { limit: 3, excludeId: issue._id }),
		countReaders(newsletter),
		getShopPayments(newsletter),
		listSignupFields(newsletter),
		listLiveRecommendations(newsletter).catch(() => []),
		hasComments ? listPublicComments(newsletter, issue) : null,
		isAudioEnabled() ? getIssueAudio(newsletter, issue).catch(() => null) : null,
	]);
	const urls = getArchiveUrls(newsletter);
	const body = renderWebIssue({ newsletter, issue, recommendations });
	// A gated issue shows its beginning to readers who haven't subscribed; its pop-up would ask the same thing twice.
	const popup = getPopupSettings(newsletter);
	const isGated = (body.kind === "article" || body.kind === "frame") && isGatedIssue(popup, issue, await listFreeIssueIds(newsletter, popup));
	// The player: everyone hears the public audio of an issue that is open; an issue the gate holds opens it for a subscriber who
	// is signed in, and a paid issue for a reader whose tier can read it. The audio route says the same (lib/reader-access.js).
	const audioPlayer = audio && {
		...audio,
		scope: issue.audience === "paid" ? "paid" : audio.scope,
		isGated,
		title: issue.subject,
		storageKey: `${newsletter.slug}:${issue.archiveSlug}`,
	};
	// An issue that places the block itself gets no second one below it.
	const closing = hasRecommendationsTag(issue.html) || hasRecommendationsTag(issue.markdown) ? [] : recommendations;
	const canSubscribePaid = Boolean(newsletter.paidTier?.enabled) && payments.ready;
	const date = getIssueDate(issue);
	const views = issue.webViews ?? 0;
	const author = getIssueAuthor(newsletter, issue);
	const issueTags = (issue.tags ?? []).map((name, index) => ({ name, slug: issue.tagSlugs?.[index] ?? getTagSlug(name) }));
	const pitch = {
		language: newsletter.language ?? "en", readerTranslations: Boolean(newsletter.readerTranslations),
		name: newsletter.name,
		slug: newsletter.slug,
		imageUrl: newsletter.imageUrl,
		description: newsletter.description,
		signupFields,
	};

	return (
		<>
			<ScriptJsonLd data={getIssueSeo(newsletter, issue).jsonLd} />
			{[...getCustomJsonLd(newsletter), ...getIssueJsonLd(issue)].map((block, index) => (
				<ScriptJsonLd key={index} data={block} />
			))}
			<article className="mx-auto max-w-2xl px-5 pt-12 sm:pt-16">
				<header className="animate-enter">
					<h1 className={issue.kind === "note" ? "sr-only" : "site-title text-4xl font-semibold tracking-tight text-balance sm:text-[2.75rem] sm:leading-[1.1]"}>
						{issue.kind === "note" ? getReaderText(newsletter)("Short post") : issue.subject}
					</h1>
					{issue.kind !== "note" && issue.previewText && (
						<p className="mt-4 text-xl text-muted-foreground text-pretty">{issue.previewText}</p>
					)}
					<div className="mt-6 flex items-center justify-between gap-4">
						<div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground tabular-nums">
							{author.slug ? (
								<a
									href={urls.author(author.slug)}
									rel="author"
									className="flex min-w-0 items-center gap-2 font-medium text-foreground transition-opacity duration-150 hover:opacity-75"
								>
									<AvatarNewsletter
										newsletter={{ name: author.name, imageUrl: author.imageUrl }}
										size={24}
										className="rounded-full"
									/>
									<span className="truncate">{author.name}</span>
								</a>
							) : (
								<span className="flex min-w-0 items-center gap-2 font-medium text-foreground">
									<AvatarNewsletter newsletter={{ name: author.name }} size={24} className="rounded-full" />
									<span className="truncate">{author.name}</span>
								</span>
							)}
							{date && <BadgeDate date={date} />}
							{views > 0 && <BadgeViews views={views} />}
						</div>
						<LinksShare
							url={urls.absolutePost(issue.archiveSlug)}
							text={issue.subject}
							className="-mr-2.5 shrink-0"
						/>
					</div>
					<ChipsTag tags={issueTags} urls={urls} className="mt-5" />
				</header>

				{isGated ? (
					<GateIssue
						preview={getGatePreview(newsletter, issue)}
						newsletter={pitch}
						post={issue.archiveSlug}
						subscribeHref={canSubscribePaid ? urls.subscribe : null}
						audio={audioPlayer}
					/>
				) : (
					<BodyIssue
						readerTranslations={Boolean(newsletter.readerTranslations)}
						language={newsletter.language ?? "en"}
						slug={newsletter.slug}
						post={issue.archiveSlug}
						initial={body}
						newsletterName={newsletter.name}
						subscribeHref={canSubscribePaid ? urls.subscribe : null}
						audio={audioPlayer}
					/>
				)}
			</article>

			{comments && (
				<SectionComments
					language={newsletter.language ?? "en"}
					slug={newsletter.slug}
					post={issue.archiveSlug}
					data={comments}
					restriction={getCommentSettings(newsletter).who === "paid" ? "On this newsletter, only paid subscribers can comment." : ""}
				/>
			)}

			{isGated ? (
				<div className={cn(more.length === 0 && closing.length === 0 && "pb-24")} />
			) : (
				<section id="subscribe" className={cn("mx-auto max-w-2xl scroll-mt-24 px-5 pt-16", more.length === 0 && closing.length === 0 && "pb-24")}>
					<div className="rounded-2xl bg-card px-6 py-10 shadow-border sm:px-10">
						<PitchSubscribe newsletter={pitch} readers={readers} />
					</div>
				</section>
			)}

			<ListRecommendations
				newsletterSlug={newsletter.slug}
				items={closing}
				className={cn("max-w-2xl pt-12", more.length === 0 && "pb-24")}
			/>

			{more.length > 0 && (
				<section className="mx-auto max-w-5xl px-5 pt-20 pb-24">
					<div className="mb-6 flex items-baseline justify-between gap-4 border-b border-border/60 pb-4">
						<h2 className="site-label text-sm font-medium text-muted-foreground">Keep reading</h2>
						<a
							href={urls.index}
							className="text-sm text-muted-foreground transition-colors duration-150 hover:text-foreground"
						>
							All issues →
						</a>
					</div>
					<ol className="grid gap-x-8 gap-y-12 sm:grid-cols-2 lg:grid-cols-3">
						{more.map((other) => (
							<li key={other._id.toString()}>
								<CardIssue issue={other} newsletter={newsletter} href={urls.post(other.archiveSlug)} />
							</li>
						))}
					</ol>
				</section>
			)}

			{!isGated && isPopupOn(popup, "issue") && <TriggerSubscribe newsletterSlug={newsletter.slug} {...getTriggerProps(popup)} />}
			<TrackView issueId={issue._id.toString()} />
		</>
	);
}
