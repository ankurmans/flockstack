import { getReaderText } from "@/lib/reader-languages";
import { notFound } from "next/navigation";
import FormBuyProduct from "@/components/FormBuyProduct";
import NoticePaid from "@/components/NoticePaid";
import { getArchiveNewsletter, getShopPayments, getShopProduct } from "@/lib/archive-data";
import { getArchiveUrls } from "@/lib/archive-hosts";
import { formatPrice } from "@/lib/payments/config";
import { getShopMetadata } from "@/lib/archive-seo";

export const revalidate = 3600;

export function generateStaticParams() {
	return [];
}

async function getProductPage(params) {
	const { slug, product: productSlug } = await params;
	const newsletter = await getArchiveNewsletter(slug);
	const product = newsletter && (await getShopProduct(newsletter, productSlug));
	return product ? { newsletter, product } : null;
}

export async function generateMetadata({ params }) {
	const page = await getProductPage(params);
	if (!page) return {};
	const { newsletter, product } = page;
	return getShopMetadata(newsletter, {
		title: `${product.title} · ${newsletter.name}`,
		description: product.description || `${product.title}, a digital product from ${newsletter.name}.`,
		url: getArchiveUrls(newsletter).absoluteProduct(product.slug),
	});
}

export default async function ProductPage({ params }) {
	const page = await getProductPage(params);
	if (!page) notFound();
	const { newsletter, product } = page;
	const payments = await getShopPayments(newsletter);
	const urls = getArchiveUrls(newsletter);

	const t = getReaderText(newsletter);

	return (
		<div className="mx-auto max-w-4xl px-5 pt-12 pb-24 sm:pt-16">
			<NoticePaid>Thanks for your order. The download link is on its way to your email: it can take a minute, and the spam folder is worth a look.</NoticePaid>
			<a href={urls.shop} className="text-sm text-muted-foreground transition-colors duration-150 hover:text-foreground">
				← {t("Shop")}
			</a>
			<div className="mt-6 grid gap-10 md:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] md:items-start">
				<div className="animate-enter">
					{product.imageUrl && (
						// eslint-disable-next-line @next/next/no-img-element
						<img src={product.imageUrl} alt="" className="mb-8 aspect-[1200/630] w-full rounded-xl bg-muted object-cover outline -outline-offset-1 outline-black/10 dark:outline-white/10" />
					)}
					<h1 className="text-4xl font-semibold tracking-tight text-balance sm:text-[2.75rem] sm:leading-[1.1]">{product.title}</h1>
					{product.description && <p className="mt-5 text-lg whitespace-pre-line text-muted-foreground text-pretty">{product.description}</p>}
				</div>
				<aside style={{ "--stagger": 1 }} className="rounded-2xl bg-card p-5 shadow-border animate-enter md:sticky md:top-24">
					<p className="text-3xl font-semibold tracking-tight tabular-nums">{formatPrice(product.priceCents, product.currency, t.language)}</p>
					<p className="mt-1 text-sm text-muted-foreground">{t("One payment. Instant download by email")}{product.file?.name ? `: ${product.file.name}` : ""}.</p>
					{payments.ready ? (
						<FormBuyProduct
							newsletterSlug={newsletter.slug}
							productSlug={product.slug}
							priceCents={product.priceCents}
							currency={product.currency}
							canJoinList
							className="mt-5"
						/>
					) : (
						<p className="mt-5 rounded-lg bg-muted/60 px-3 py-2.5 text-sm text-muted-foreground">{t("This product can't be bought right now. Check back soon.")}</p>
					)}
				</aside>
			</div>
		</div>
	);
}
