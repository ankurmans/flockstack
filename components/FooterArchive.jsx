import { getReaderText } from "@/lib/reader-languages";
import { getArchiveUrls } from "@/lib/archive-hosts";
import { Rss } from "lucide-react";
import AvatarNewsletter from "@/components/AvatarNewsletter";
import LinksSocial from "@/components/LinksSocial";
import NavSite from "@/components/NavSite";
import { currentYear } from "@/lib/format";
import { SENT_WITH_TEXT, SENT_WITH_URL } from "@/lib/site";

export default function FooterArchive({ newsletter, indexHref, feedHref, navLinks = [] }) {
	const t = getReaderText(newsletter);
	return (
		<footer className="border-t border-border/60">
			<div className="mx-auto grid max-w-5xl gap-6 px-5 pt-10 pb-6 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
				<div className="flex flex-col gap-3">
					<a href={indexHref} className="flex items-center gap-2.5 font-medium tracking-tight">
						<AvatarNewsletter newsletter={newsletter} size={28} />
						{newsletter.name}
					</a>
					{newsletter.description && (
						<p className="max-w-sm text-sm text-muted-foreground text-pretty">{newsletter.description}</p>
					)}
					<NavSite links={navLinks} className="mt-1" />
					{newsletter.sponsorships?.enabled && !newsletter.comingSoon && <a href={getArchiveUrls(newsletter).sponsor} className="text-sm underline underline-offset-4">{t("Sponsor this newsletter")}</a>}
				</div>
				<LinksSocial links={newsletter.socialLinks} className="-ml-2.5 sm:-mr-2.5 sm:ml-0" />
			</div>
			<div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-5 pb-10 text-xs text-muted-foreground">
				<p className="tabular-nums">
					© {currentYear()} {newsletter.name}
				</p>
				{feedHref && (
					<a
						href={feedHref}
						type="application/rss+xml"
						className="inline-flex items-center gap-1.5 transition-colors duration-150 hover:text-foreground"
					>
						<Rss className="size-3.5" aria-hidden="true" />
						{t("RSS feed")}
					</a>
				)}
			</div>
			{newsletter.sentWith && (
				<p className="mx-auto max-w-5xl px-5 pb-8 text-xs text-muted-foreground">
					<a href={SENT_WITH_URL} data-sent-with className="underline underline-offset-4 transition-colors duration-150 hover:text-foreground">
						{SENT_WITH_TEXT}
					</a>
				</p>
			)}
		</footer>
	);
}
