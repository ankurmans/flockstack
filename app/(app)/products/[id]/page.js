import { notFound } from "next/navigation";
import FormProduct from "@/components/FormProduct";
import HeaderPage from "@/components/HeaderPage";
import LayoutNarrow from "@/components/LayoutNarrow";
import { runDashboardAction } from "@/lib/actions/dashboard";
import { getPaymentsState } from "@/lib/payments/connect";
import { MAX_PRODUCT_FILE_BYTES } from "@/lib/products";
import { getSelectedNewsletter, openNewsletter } from "@/lib/selected-newsletter";

export const metadata = { title: "Product" };

export default async function ProductPage({ params }) {
	const [{ id }, view] = await Promise.all([params, getSelectedNewsletter()]);
	const { output: product } = await runDashboardAction("get_product", { id });
	if (!product) notFound();
	openNewsletter(view, product.newsletterId, `/products/${id}`);

	return (
		<LayoutNarrow>
			<HeaderPage title={product.title} backHref="/products" />
			<FormProduct product={product} payments={getPaymentsState(view.account)} maxFileMb={MAX_PRODUCT_FILE_BYTES / 1024 / 1024} />
		</LayoutNarrow>
	);
}
