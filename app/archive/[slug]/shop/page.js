import { notFound } from "next/navigation";
import CardProduct from "@/components/CardProduct";
import CardPaidTier from "@/components/CardPaidTier";
import { getArchiveNewsletter, getShopPayments, listShopProducts } from "@/lib/archive-data";
import { getArchiveUrls } from "@/lib/archive-hosts";
import { getShopMetadata } from "@/lib/archive-seo";

export const revalidate = 3600;

export function generateStaticParams() {
	return [];
}

export async function generateMetadata({ params }) {
	const newsletter = await getArchiveNewsletter((await params).slug);
	if (!newsletter) return {};
	return getShopMetadata(newsletter, {
		title: `Shop · ${newsletter.name}`,
		description: `Digital products from ${newsletter.name}.`,
		url: getArchiveUrls(newsletter).absoluteShop,
	});
}

export default async function ShopPage({ params }) {
	const newsletter = await getArchiveNewsletter((await params).slug);
	if (!newsletter) notFound();
	const [products, payments] = await Promise.all([listShopProducts(newsletter), getShopPayments(newsletter)]);
	const urls = getArchiveUrls(newsletter);
	const isPaidTierOpen = Boolean(newsletter.paidTier?.enabled) && payments.ready;
	// A shop with nothing on sale is a page nobody linked to.
	if ((products.length === 0 || !payments.ready) && !isPaidTierOpen) notFound();

	return (
		<div className="mx-auto max-w-5xl px-5 pt-16 pb-24 sm:pt-20">
			<h1 className="text-4xl font-semibold tracking-tight text-balance animate-enter sm:text-5xl">Shop</h1>
			<p style={{ "--stagger": 1 }} className="mt-3 max-w-xl text-lg text-muted-foreground text-pretty animate-enter">
				Digital products from {newsletter.name}. You get the download link by email as soon as you&apos;ve paid.
			</p>
			{isPaidTierOpen && (
				<div style={{ "--stagger": 2 }} className="mt-10 animate-enter">
					<CardPaidTier newsletter={newsletter} href={urls.subscribe} />
				</div>
			)}
			{payments.ready && products.length > 0 && (
				<ol style={{ "--stagger": 3 }} className="mt-12 grid gap-x-8 gap-y-12 animate-enter sm:grid-cols-2 lg:grid-cols-3">
					{products.map((product) => (
						<li key={String(product._id)}>
							<CardProduct product={product} href={urls.product(product.slug)} />
						</li>
					))}
				</ol>
			)}
		</div>
	);
}
