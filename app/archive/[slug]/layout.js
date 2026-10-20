import { notFound } from "next/navigation";
import BannerOffer from "@/components/BannerOffer";
import FooterArchive from "@/components/FooterArchive";
import HeaderArchive from "@/components/HeaderArchive";
import ProviderSubscribe from "@/components/ProviderSubscribe";
import { countReaders, getArchiveNewsletter, getShopPayments, listShopProducts, listSignupFields } from "@/lib/archive-data";
import { getArchiveUrls } from "@/lib/archive-hosts";
import { getLaunchBanner } from "@/lib/offers";

export default async function ArchiveLayout({ children, params }) {
	const newsletter = await getArchiveNewsletter((await params).slug);
	if (!newsletter) notFound();

	const [readers, products, payments, signupFields, banner] = await Promise.all([
		countReaders(newsletter),
		listShopProducts(newsletter),
		getShopPayments(newsletter),
		listSignupFields(newsletter),
		getLaunchBanner(newsletter),
	]);
	const urls = getArchiveUrls(newsletter);
	const { index, shop, subscribe, feed } = urls;
	const hasProducts = payments.ready && products.length > 0;
	const shopLink = hasProducts || (payments.ready && (newsletter.paidTier?.enabled || newsletter.paidTier?.pledges?.enabled)) ? { href: hasProducts || newsletter.paidTier?.enabled ? shop : subscribe, label: hasProducts ? "Shop" : newsletter.paidTier?.enabled ? "Go paid" : "Pledge" } : null;
	const pitch = {
		name: newsletter.name,
		slug: newsletter.slug,
		imageUrl: newsletter.imageUrl,
		description: newsletter.description,
		signupFields,
	};

	return (
		<ProviderSubscribe newsletter={pitch} readers={readers}>
			<div className="theme-neutral flex min-h-dvh flex-col">
				{banner && payments.ready && <BannerOffer text={banner.text} href={banner.offerCode ? urls.offer(banner.offerCode) : subscribe} />}
				<HeaderArchive newsletter={newsletter} indexHref={index} shopLink={shopLink} />
				<main className="flex-1">{children}</main>
				<FooterArchive newsletter={newsletter} indexHref={index} feedHref={feed} />
			</div>
		</ProviderSubscribe>
	);
}
