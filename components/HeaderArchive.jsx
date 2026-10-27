import { getReaderText } from "@/lib/reader-languages";
import AvatarNewsletter from "@/components/AvatarNewsletter";
import ButtonSubscribe from "@/components/ButtonSubscribe";
import LinkReader from "@/components/LinkReader";
import NavSite from "@/components/NavSite";
import { readerMarkerName } from "@/lib/reader-cookies";

// shopLink: { href, label } while the newsletter sells something. navLinks: the writer's navigation bar, which wraps to a
// row of its own on a phone. signinHref and accountHref: the reader's sign-in and Subscriber Center.
export default function HeaderArchive({ newsletter, indexHref, shopLink = null, navLinks = [], signinHref, accountHref }) {
	const t = getReaderText(newsletter);
	return (
		<header className="sticky top-0 z-30 border-b border-border/60 bg-background/80 backdrop-blur-md">
			<div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-x-5 px-5">
				<a href={indexHref} className="flex h-14 min-w-0 items-center gap-2.5 font-medium tracking-tight">
					<AvatarNewsletter newsletter={newsletter} size={28} />
					<span className="truncate">{newsletter.name}</span>
				</a>
				<NavSite links={navLinks} className="order-last -mx-5 w-[calc(100%+2.5rem)] px-5 pb-3 sm:order-none sm:mx-0 sm:w-auto sm:min-w-0 sm:flex-1 sm:px-0 sm:pb-0" />
				<div className="flex h-14 items-center gap-4">
					{shopLink && (
						<a href={shopLink.href} className="text-sm font-medium text-muted-foreground transition-colors duration-150 hover:text-foreground">
							{t(shopLink.label)}
						</a>
					)}
					<LinkReader
						marker={readerMarkerName(newsletter.slug)}
						signinHref={signinHref}
						accountHref={accountHref}
						className="text-sm font-medium text-muted-foreground transition-colors duration-150 hover:text-foreground"
					/>
					<ButtonSubscribe />
				</div>
			</div>
		</header>
	);
}
