import { notFound } from "next/navigation";
import AvatarNewsletter from "@/components/AvatarNewsletter";
import BadgeDate from "@/components/BadgeDate";
import BadgeViews from "@/components/BadgeViews";
import BodyIssue from "@/components/BodyIssue";
import CardIssue from "@/components/CardIssue";
import ChipsTag from "@/components/ChipsTag";
import LinksShare from "@/components/LinksShare";
import ListRecommendations from "@/components/ListRecommendations";
import PitchSubscribe from "@/components/PitchSubscribe";
import SectionComments from "@/components/SectionComments";
import ScriptJsonLd from "@/components/ScriptJsonLd";
import TrackView from "@/components/TrackView";
import TriggerSubscribe from "@/components/TriggerSubscribe";
import { getIssueAuthor } from "@/lib/archive-author";
import { renderPageBody } from "@/lib/archive-content";
import { countReaders, getArchiveIssue, getArchiveNewsletter, getArchivePage, getShopPayments, listArchiveIssues, listSignupFields } from "@/lib/archive-data";
import { getArchiveUrls } from "@/lib/archive-hosts";
import { getBrand } from "@/lib/brand";
import { getIssueDate } from "@/lib/archive-issues";
import { getIssueSeo, getPageSeo } from "@/lib/archive-seo";
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
	return post.issue ? getIssueSeo(post.newsletter, post.issue).metadata : getPageSeo(post.newsletter, post.page).metadata;
}

export default async function PostPage({ params }) {
	const post = await getPost(params);
	if (!post) notFound();
	// Called, not rendered as components, so the page's output is the finished tree.
	return post.issue ? await renderIssue(post) : await renderPage(post);
}

async function renderPage({ newsletter, page }) {
	const [readers, signupFields] = await Promise.all([countReaders(newsletter), listSignupFields(newsletter)]);
	const pitch = { name: newsletter.name, slug: newsletter.slug, imageUrl: newsletter.imageUrl, description: newsletter.description, signupFields };

	return (
		<>
			<ScriptJsonLd data={getPageSeo(newsletter, page).jsonLd} />
			<article className="mx-auto max-w-2xl px-5 pt-12 sm:pt-16">
				<h1 className="site-title text-4xl font-semibold tracking-tight text-balance animate-enter sm:text-[2.75rem] sm:leading-[1.1]">{page.title}</h1>
				<div
					style={{ "--stagger": 1 }}
					className="prose-issue mt-10 animate-enter"
					dangerouslySetInnerHTML={{ __html: renderPageBody(page.html, { accent: getBrand(newsletter).accent }) }}
				/>
			</article>
			<section id="subscribe" className="mx-auto max-w-2xl scroll-mt-24 px-5 pt-16 pb-24">
				<div className="rounded-2xl bg-card px-6 py-10 shadow-border sm:px-10">
					<PitchSubscribe newsletter={pitch} readers={readers} />
				</div>
			</section>
			<TriggerSubscribe newsletterSlug={newsletter.slug} />
		</>
	);
}

async function renderIssue({ newsletter, issue }) {

	const hasComments = areCommentsOn(newsletter, issue);
	const [more, readers, payments, signupFields, recommendations, comments] = await Promise.all([
		listArchiveIssues(newsletter, { limit: 3, excludeId: issue._id }),
		countReaders(newsletter),
		getShopPayments(newsletter),
		listSignupFields(newsletter),
		listLiveRecommendations(newsletter).catch(() => []),
		hasComments ? listPublicComments(newsletter, issue) : null,
	]);
	const urls = getArchiveUrls(newsletter);
	const body = renderWebIssue({ newsletter, issue, recommendations });
	// An issue that places the block itself gets no second one below it.
	const closing = hasRecommendationsTag(issue.html) || hasRecommendationsTag(issue.markdown) ? [] : recommendations;
	const canSubscribePaid = Boolean(newsletter.paidTier?.enabled) && payments.ready;
	const date = getIssueDate(issue);
	const views = issue.webViews ?? 0;
	const author = getIssueAuthor(newsletter, issue);
	const issueTags = (issue.tags ?? []).map((name, index) => ({ name, slug: issue.tagSlugs?.[index] ?? getTagSlug(name) }));
	const pitch = {
		name: newsletter.name,
		slug: newsletter.slug,
		imageUrl: newsletter.imageUrl,
		description: newsletter.description,
		signupFields,
	};

	return (
		<>
			<ScriptJsonLd data={getIssueSeo(newsletter, issue).jsonLd} />
			<article className="mx-auto max-w-2xl px-5 pt-12 sm:pt-16">
				<header className="animate-enter">
					<h1 className="site-title text-4xl font-semibold tracking-tight text-balance sm:text-[2.75rem] sm:leading-[1.1]">
						{issue.subject}
					</h1>
					{issue.previewText && (
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

				<BodyIssue
					slug={newsletter.slug}
					post={issue.archiveSlug}
					initial={body}
					newsletterName={newsletter.name}
					subscribeHref={canSubscribePaid ? urls.subscribe : null}
				/>
			</article>

			{comments && (
				<SectionComments
					slug={newsletter.slug}
					post={issue.archiveSlug}
					data={comments}
					restriction={getCommentSettings(newsletter).who === "paid" ? "On this newsletter, only paid subscribers can comment." : ""}
				/>
			)}

			<section id="subscribe" className={cn("mx-auto max-w-2xl scroll-mt-24 px-5 pt-16", more.length === 0 && closing.length === 0 && "pb-24")}>
				<div className="rounded-2xl bg-card px-6 py-10 shadow-border sm:px-10">
					<PitchSubscribe newsletter={pitch} readers={readers} />
				</div>
			</section>

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

			<TriggerSubscribe newsletterSlug={newsletter.slug} />
			<TrackView issueId={issue._id.toString()} />
		</>
	);
}
