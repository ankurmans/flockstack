import { notFound } from "next/navigation";
import FooterArchive from "@/components/FooterArchive";
import HeaderArchive from "@/components/HeaderArchive";
import ProviderSubscribe from "@/components/ProviderSubscribe";
import TrackVisit from "@/components/TrackVisit";
import { countReaders, getArchiveNewsletter, getShopPayments, listShopProducts, listSignupFields } from "@/lib/archive-data";
import { getArchiveUrls } from "@/lib/archive-hosts";

export default async function ArchiveLayout({ children, params }) {
	const newsletter = await getArchiveNewsletter((await params).slug);
	if (!newsletter) notFound();

	const [readers, products, payments, signupFields] = await Promise.all([
		countReaders(newsletter),
		listShopProducts(newsletter),
		getShopPayments(newsletter),
		listSignupFields(newsletter),
	]);
	const { index, shop, feed } = getArchiveUrls(newsletter);
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
			<div className="theme-neutral flex min-h-dvh flex-col">
				<HeaderArchive newsletter={newsletter} indexHref={index} shopLink={shopLink} />
				<main className="flex-1">{children}</main>
				<FooterArchive newsletter={newsletter} indexHref={index} feedHref={feed} />
				<TrackVisit slug={newsletter.slug} />
			</div>
		</ProviderSubscribe>
	);
}
