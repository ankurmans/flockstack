import Link from "next/link";
import { ShoppingBag } from "lucide-react";
import BadgeStatus from "@/components/BadgeStatus";
import DialogCreateProduct from "@/components/DialogCreateProduct";
import GatePlan from "@/components/GatePlan";
import HeaderPage from "@/components/HeaderPage";
import StateEmpty from "@/components/StateEmpty";
import TextEmpty from "@/components/TextEmpty";
import { Button } from "@/components/ui/button";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { runDashboardAction } from "@/lib/actions/dashboard";
import { formatCount } from "@/lib/format";
import { formatPrice } from "@/lib/payments/config";
import { getPaymentsState } from "@/lib/payments/connect";
import { getSelectedNewsletter } from "@/lib/selected-newsletter";

export const metadata = { title: "Products" };

// The open newsletter's digital products: files readers buy once. They sell on the newsletter's site, at /shop.
export default async function ProductsPage() {
	const { account, selected } = await getSelectedNewsletter();
	const listed = selected ? await runDashboardAction("list_products", { newsletter: String(selected._id) }) : null;
	const products = listed?.output?.products ?? [];
	const payments = getPaymentsState(account);

	return (
		<>
			<HeaderPage title="Products">
				{selected && (
					<GatePlan reason="sell">
						<DialogCreateProduct newsletterId={String(selected._id)} />
					</GatePlan>
				)}
			</HeaderPage>

			<div className="flex flex-col gap-6">
				{!payments.ready && (
					<p className="flex flex-col gap-2 rounded-xl bg-muted/60 px-4 py-3 text-sm text-pretty sm:flex-row sm:items-center sm:justify-between animate-enter">
						<span>{payments.problem}. Products can be made now and go on sale once payments are ready.</span>
						<Button asChild variant="outline" size="sm" className="shrink-0">
							<Link href="/payments">Payments</Link>
						</Button>
					</p>
				)}
				{products.length === 0 ? (
					<StateEmpty icon={ShoppingBag} title="No products yet">
						<p className="max-w-sm text-sm text-pretty text-muted-foreground">
							Sell a template, a guide or a pack of files to your readers. They pay once and get an expiring download link by email. FlockStack takes no cut.
						</p>
					</StateEmpty>
				) : (
					<div className="overflow-hidden rounded-xl shadow-border animate-enter">
						<Table>
							<TableHeader>
								<TableRow className="hover:bg-transparent">
									<TableHead className="pl-4">Product</TableHead>
									<TableHead>Price</TableHead>
									<TableHead>Status</TableHead>
									<TableHead className="hidden text-right sm:table-cell">Sold</TableHead>
									<TableHead className="hidden pr-4 text-right md:table-cell">Earned</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{products.map((product) => (
									<TableRow key={product.id}>
										<TableCell className="max-w-0 py-2.5 pl-4 font-medium">
											<Link href={`/products/${product.id}`} className="block truncate hover:underline">
												{product.title}
											</Link>
										</TableCell>
										<TableCell className="tabular-nums">{formatPrice(product.priceCents, product.currency)}</TableCell>
										<TableCell>
											<BadgeStatus status={product.status === "active" ? "active" : product.status} label={product.status === "active" ? "On sale" : undefined} />
										</TableCell>
										<TableCell className="hidden text-right text-muted-foreground tabular-nums sm:table-cell">
											{product.sales > 0 ? formatCount(product.sales, "order") : <TextEmpty />}
										</TableCell>
										<TableCell className="hidden pr-4 text-right text-muted-foreground tabular-nums md:table-cell">
											{product.sales > 0 ? formatPrice(product.revenueCents, product.currency) : <TextEmpty />}
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					</div>
				)}
			</div>
		</>
	);
}
