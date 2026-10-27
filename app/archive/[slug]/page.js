import Image from "next/image";
import { notFound } from "next/navigation";
import AvatarNewsletter from "@/components/AvatarNewsletter";
import CardIssue from "@/components/CardIssue";
import FormSubscribe from "@/components/FormSubscribe";
import PageComingSoon from "@/components/PageComingSoon";
import LinksSocial from "@/components/LinksSocial";
import ListIssues from "@/components/ListIssues";
import ListRecommendations from "@/components/ListRecommendations";
import ScriptJsonLd from "@/components/ScriptJsonLd";
import TriggerSubscribe from "@/components/TriggerSubscribe";
import { HOME_ISSUES, countReaders, getArchiveSite, listHomeIssues, listSignupFields } from "@/lib/archive-data";
import { getArchiveUrls } from "@/lib/archive-hosts";
import { getComingSoonSeo, getCustomJsonLd, getHomeSeo, getPrivateSeo } from "@/lib/archive-seo";
import { getBrand } from "@/lib/brand";
import { formatNumber } from "@/lib/format";
import { getPopupSettings, getTriggerProps, isPopupOn } from "@/lib/popup-rules";
import { cn } from "@/lib/utils";
import { listLiveRecommendations } from "@/lib/recommendations";

export const revalidate = 3600;

export function generateStaticParams() {
	return [];
}

export async function generateMetadata({ params }) {
	const newsletter = await getArchiveSite((await params).slug);
	if (!newsletter) return {};
	if (newsletter.privateArchive) return getPrivateSeo(newsletter);
	return newsletter.comingSoon ? getComingSoonSeo(newsletter) : getHomeSeo(newsletter).metadata;
}

export default async function ArchivePage({ params }) {
	const newsletter = await getArchiveSite((await params).slug);
	if (!newsletter) notFound();
	if (newsletter.privateArchive) return <PageComingSoon newsletter={newsletter} signupFields={await listSignupFields(newsletter)} isPrivate />;
	if (newsletter.comingSoon) return <PageComingSoon newsletter={newsletter} signupFields={await listSignupFields(newsletter)} />;

	const [home, readers, signupFields, recommendations] = await Promise.all([
		listHomeIssues(newsletter),
		countReaders(newsletter),
		listSignupFields(newsletter),
		listLiveRecommendations(newsletter).catch(() => []),
	]);
	const urls = getArchiveUrls(newsletter);
	const popup = getPopupSettings(newsletter);
	const brand = getBrand(newsletter);
	const { pinned, recent, total } = home;
	// With pinned issues, or the minimal theme's plain list, no issue gets the big card of the latest.
	const hasLatestCard = pinned.length === 0 && brand.theme !== "minimal";
	const latest = hasLatestCard ? recent[0] : null;
	const rest = hasLatestCard ? recent.slice(1, HOME_ISSUES + 1) : recent.slice(0, HOME_ISSUES);
	const hasMore = total > pinned.length + (latest ? 1 : 0) + rest.length;

	return (
		<>
			<ScriptJsonLd data={getHomeSeo(newsletter).jsonLd} />
			{getCustomJsonLd(newsletter).map((block, index) => (
				<ScriptJsonLd key={index} data={block} />
			))}
			{brand.headerUrl && (
				<div className="mx-auto max-w-5xl px-5 pt-6">
					<div className="relative aspect-[3/1] overflow-hidden rounded-xl bg-muted outline -outline-offset-1 outline-black/10 dark:outline-white/10">
						<Image src={brand.headerUrl} alt="" fill sizes="(min-width: 1024px) 1024px, 100vw" unoptimized priority className="object-cover" />
					</div>
				</div>
			)}
			<section className="site-hero relative isolate overflow-hidden">
				<div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[34rem] bg-dots" />
				<div className="site-hero-inner mx-auto flex max-w-2xl flex-col items-center px-5 pt-16 pb-14 text-center sm:pt-24 sm:pb-20">
					<AvatarNewsletter
						newsletter={newsletter}
						size={72}
						className="rounded-2xl shadow-[0_8px_24px_-8px_rgb(0_0_0/0.25)] animate-enter"
					/>
					<h1 style={{ "--stagger": 1 }} className="site-title mt-6 text-4xl font-semibold tracking-tight animate-enter sm:text-5xl">
						{newsletter.name}
					</h1>
					{newsletter.description && (
						<p
							style={{ "--stagger": 2 }}
							className="mt-4 max-w-xl text-lg text-muted-foreground text-balance animate-enter"
						>
							{newsletter.description}
						</p>
					)}
					<div
						id="subscribe"
						style={{ "--stagger": 3 }}
						className="mt-8 w-full max-w-md scroll-mt-24 animate-enter"
					>
						<FormSubscribe newsletterSlug={newsletter.slug} fields={signupFields} />
					</div>
					<div style={{ "--stagger": 4 }} className="mt-4 flex flex-col items-center gap-4 animate-enter">
						{readers >= 100 && (
							<p className="text-sm text-muted-foreground tabular-nums">
								Join {formatNumber(readers)} readers. Free, unsubscribe anytime.
							</p>
						)}
						<LinksSocial links={newsletter.socialLinks} />
					</div>
				</div>
			</section>

			{pinned.length > 0 && (
				<section style={{ "--stagger": 5 }} className="mx-auto max-w-5xl px-5 animate-enter">
					<h2 className="site-label mb-6 text-sm font-medium text-muted-foreground">Featured</h2>
					<ListIssues issues={pinned} newsletter={newsletter} urls={urls} theme={brand.theme} />
				</section>
			)}

			{latest && (
				<section style={{ "--stagger": 5 }} className="mx-auto max-w-5xl px-5 animate-enter">
					<h2 className="site-label mb-4 text-sm font-medium text-muted-foreground">Latest issue</h2>
					<CardIssue
						issue={latest}
						newsletter={newsletter}
						href={urls.post(latest.archiveSlug)}
						isFeatured
						isEager
					/>
				</section>
			)}

			{rest.length > 0 && (
				<section className={cn("mx-auto max-w-5xl px-5 pt-20", recommendations.length > 0 ? "pb-16" : "pb-24")}>
					<div className="mb-6 flex items-baseline justify-between gap-4 border-b border-border/60 pb-4">
						<h2 className="site-label text-sm font-medium text-muted-foreground">{hasMore || pinned.length > 0 ? "Recent issues" : "All issues"}</h2>
						<a href={urls.issues} className="text-sm text-muted-foreground transition-colors duration-150 hover:text-foreground">
							{hasMore ? `All ${total} issues →` : "Search and tags →"}
						</a>
					</div>
					<ListIssues issues={rest} newsletter={newsletter} urls={urls} theme={brand.theme} />
				</section>
			)}
			<ListRecommendations newsletterSlug={newsletter.slug} items={recommendations} className="pt-12 pb-24" />
			{isPopupOn(popup, "home") && <TriggerSubscribe newsletterSlug={newsletter.slug} {...getTriggerProps(popup)} />}
		</>
	);
}
