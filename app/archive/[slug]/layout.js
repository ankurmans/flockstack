import { notFound } from "next/navigation";
import FooterArchive from "@/components/FooterArchive";
import HeaderArchive from "@/components/HeaderArchive";
import ProviderSubscribe from "@/components/ProviderSubscribe";
import StyleSite from "@/components/StyleSite";
import TrackVisit from "@/components/TrackVisit";
import { countReaders, getArchiveNewsletter, getShopPayments, listPublishedPages, listShopProducts, listSignupFields } from "@/lib/archive-data";
import { getArchiveUrls } from "@/lib/archive-hosts";
import { getBrand } from "@/lib/brand";
import { getNavLinks } from "@/lib/site-navigation";

export default async function ArchiveLayout({ children, params }) {
	const newsletter = await getArchiveNewsletter((await params).slug);
	if (!newsletter) notFound();

	const [readers, products, payments, signupFields, pages] = await Promise.all([
		countReaders(newsletter),
		listShopProducts(newsletter),
		getShopPayments(newsletter),
		listSignupFields(newsletter),
		listPublishedPages(newsletter),
	]);
	const urls = getArchiveUrls(newsletter);
	const { index, shop, feed } = urls;
	const theme = getBrand(newsletter).theme;
	const navLinks = getNavLinks(newsletter, pages, urls);
	const hasProducts = payments.ready && products.length > 0;
	const shopLink = hasProducts || (payments.ready && newsletter.paidTier?.enabled) ? { href: shop, label: hasProducts ? "Shop" : "Go paid" } : null;
	const pitch = {
		name: newsletter.name,
		slug: newsletter.slug,
		imageUrl: newsletter.imageUrl,
		description: newsletter.description,
		signupFields,
	};

	return (
		<ProviderSubscribe newsletter={pitch} readers={readers}>
			<StyleSite newsletter={newsletter} only={theme} />
			<div data-site-theme={theme} className="theme-neutral flex min-h-dvh flex-col bg-background text-foreground">
				<HeaderArchive
					newsletter={newsletter}
					indexHref={index}
					shopLink={shopLink}
					navLinks={navLinks}
					signinHref={urls.signin}
					accountHref={urls.account}
				/>
				<main className="flex-1">{children}</main>
				<FooterArchive newsletter={newsletter} indexHref={index} feedHref={feed} navLinks={navLinks} />
				<TrackVisit slug={newsletter.slug} />
			</div>
		</ProviderSubscribe>
	);
}
