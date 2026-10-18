import { notFound } from "next/navigation";
import FooterArchive from "@/components/FooterArchive";
import HeaderArchive from "@/components/HeaderArchive";
import ProviderSubscribe from "@/components/ProviderSubscribe";
import { countReaders, getArchiveNewsletter, getShopPayments, listShopProducts } from "@/lib/archive-data";
import { getArchiveUrls } from "@/lib/archive-hosts";

export default async function ArchiveLayout({ children, params }) {
	const newsletter = await getArchiveNewsletter((await params).slug);
	if (!newsletter) notFound();

	const [readers, products, payments] = await Promise.all([countReaders(newsletter), listShopProducts(newsletter), getShopPayments(newsletter)]);
	const { index, shop } = getArchiveUrls(newsletter);
	const hasProducts = payments.ready && products.length > 0;
	const shopLink = hasProducts || (payments.ready && newsletter.paidTier?.enabled) ? { href: shop, label: hasProducts ? "Shop" : "Go paid" } : null;
	const pitch = {
		name: newsletter.name,
		slug: newsletter.slug,
		imageUrl: newsletter.imageUrl,
		description: newsletter.description,
	};

	return (
		<ProviderSubscribe newsletter={pitch} readers={readers}>
			<div className="flex min-h-dvh flex-col">
				<HeaderArchive newsletter={newsletter} indexHref={index} shopLink={shopLink} />
				<main className="flex-1">{children}</main>
				<FooterArchive newsletter={newsletter} indexHref={index} />
			</div>
		</ProviderSubscribe>
	);
}
