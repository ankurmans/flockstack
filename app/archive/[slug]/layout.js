import { notFound } from "next/navigation";
import BannerOffer from "@/components/BannerOffer";
import FooterArchive from "@/components/FooterArchive";
import HeaderArchive from "@/components/HeaderArchive";
import ProviderSubscribe from "@/components/ProviderSubscribe";
import StyleSite from "@/components/StyleSite";
import TrackVisit from "@/components/TrackVisit";
import { countReaders, getArchiveSite, getShopPayments, listPublishedPages, listShopProducts, listSignupFields } from "@/lib/archive-data";
import { getArchiveUrls } from "@/lib/archive-hosts";
import { getLaunchBanner } from "@/lib/offers";
import { getBrand } from "@/lib/brand";
import { getNavLinks } from "@/lib/site-navigation";

export default async function ArchiveLayout({ children, params }) {
	const newsletter = await getArchiveSite((await params).slug);
	if (!newsletter) notFound();
	// Before its first issue the website is one page: no shop, no navigation, no feed to link to.
	const { comingSoon } = newsletter;

	const [readers, products, payments, signupFields, pages, banner] = await Promise.all([
		countReaders(newsletter),
		listShopProducts(newsletter),
		getShopPayments(newsletter),
		listSignupFields(newsletter),
		listPublishedPages(newsletter),
		getLaunchBanner(newsletter),
	]);
	const urls = getArchiveUrls(newsletter);
	const { index, shop, subscribe, feed } = urls;
	const theme = getBrand(newsletter).theme;
	const isPrivate = Boolean(newsletter.privateArchive);
	const navLinks = comingSoon || isPrivate ? [] : getNavLinks(newsletter, pages, urls);
	const hasProducts = !comingSoon && payments.ready && products.length > 0;
	const shopLink = comingSoon ? null : hasProducts || (payments.ready && (newsletter.paidTier?.enabled || newsletter.paidTier?.pledges?.enabled)) ? { href: hasProducts || newsletter.paidTier?.enabled ? shop : subscribe, label: hasProducts ? "Shop" : newsletter.paidTier?.enabled ? "Go paid" : "Pledge" } : null;
	const pitch = {
		name: newsletter.name,
		language: newsletter.language ?? "en",
		slug: newsletter.slug,
		imageUrl: newsletter.imageUrl,
		description: newsletter.description,
		signupFields,
	};

	return (
		<ProviderSubscribe newsletter={pitch} readers={readers}>
			<StyleSite newsletter={newsletter} only={theme} />
			<div lang={newsletter.language ?? "en"} data-site-theme={theme} className="theme-neutral flex min-h-dvh flex-col bg-background text-foreground">
				{!comingSoon && banner && payments.ready && <BannerOffer text={banner.text} href={banner.offerCode ? urls.offer(banner.offerCode) : subscribe} />}
				<HeaderArchive
					newsletter={newsletter}
					indexHref={index}
					shopLink={shopLink}
					navLinks={navLinks}
					signinHref={urls.signin}
					accountHref={urls.account}
				/>
				<main className="flex-1">{children}</main>
				<FooterArchive newsletter={newsletter} indexHref={index} feedHref={comingSoon || isPrivate ? null : feed} navLinks={navLinks} />
				<TrackVisit slug={newsletter.slug} />
			</div>
		</ProviderSubscribe>
	);
}
