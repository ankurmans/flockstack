import Link from "next/link";
import { ChevronRight, Receipt } from "lucide-react";
import BadgeStatus from "@/components/BadgeStatus";
import ButtonResendOrder from "@/components/ButtonResendOrder";
import HeaderPage from "@/components/HeaderPage";
import StateEmpty from "@/components/StateEmpty";
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
import { formatDate } from "@/lib/format";
import { formatPrice } from "@/lib/payments/config";

export const metadata = { title: "Orders" };

const EMAIL_LABELS = { sent: "Link sent", pending: "Sending", suppressed: "Address bounced", failed: "Link not sent" };
const EMAIL_STATUS = { sent: "sent", pending: "pending", suppressed: "bounced", failed: "failed" };

// What readers bought, newest first, across the account's newsletters. Refunds are made in Stripe; a full refund stops
// the buyer's download link by itself.
export default async function OrdersPage({ searchParams }) {
	const { cursor } = await searchParams;
	const { output } = await runDashboardAction("list_orders", { limit: 25, cursor: typeof cursor === "string" ? cursor : undefined });
	const orders = output?.orders ?? [];

	return (
		<>
			<HeaderPage title="Orders" />
			{orders.length === 0 && !cursor ? (
				<StateEmpty icon={Receipt} title="No orders yet">
					<p className="max-w-sm text-sm text-pretty text-muted-foreground">Orders show up here when a reader buys one of your products. They get their download link by email.</p>
				</StateEmpty>
			) : (
				<div className="flex flex-col gap-4">
					<div className="overflow-hidden rounded-xl shadow-border animate-enter">
						<Table>
							<TableHeader>
								<TableRow className="hover:bg-transparent">
									<TableHead className="pl-4">Buyer</TableHead>
									<TableHead className="hidden sm:table-cell">Product</TableHead>
									<TableHead>Paid</TableHead>
									<TableHead>Status</TableHead>
									<TableHead className="hidden lg:table-cell">Email</TableHead>
									<TableHead className="hidden md:table-cell">Date</TableHead>
									<TableHead className="w-28 pr-2" />
								</TableRow>
							</TableHeader>
							<TableBody>
								{orders.map((order) => (
									<TableRow key={order.id}>
										<TableCell className="max-w-0 py-2.5 pl-4 font-medium">
											<span className="block truncate">{order.buyerEmail}</span>
											{order.buyerName && <span className="block truncate text-xs font-normal text-muted-foreground">{order.buyerName}</span>}
										</TableCell>
										<TableCell className="hidden max-w-0 truncate text-muted-foreground sm:table-cell">
											<Link href={`/products/${order.productId}`} className="hover:underline">
												{order.productTitle}
											</Link>
										</TableCell>
										<TableCell className="tabular-nums">
											{formatPrice(order.amountCents, order.currency)}
											{order.amountRefundedCents > 0 && (
												<span className="block text-xs text-muted-foreground">{formatPrice(order.amountRefundedCents, order.currency)} refunded</span>
											)}
										</TableCell>
										<TableCell>
											<BadgeStatus status={order.status === "paid" ? "success" : "failed"} label={order.status === "paid" ? "Paid" : order.status === "refunded" ? "Refunded" : "Disputed"} />
										</TableCell>
										<TableCell className="hidden lg:table-cell">
											<BadgeStatus status={EMAIL_STATUS[order.emailStatus]} label={EMAIL_LABELS[order.emailStatus]} />
										</TableCell>
										<TableCell className="hidden text-muted-foreground md:table-cell">{formatDate(order.paidAt)}</TableCell>
										<TableCell className="pr-2 text-right">{order.status === "paid" && <ButtonResendOrder id={order.id} email={order.buyerEmail} />}</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					</div>
					<div className="flex items-center justify-between gap-3">
						<p className="text-xs text-pretty text-muted-foreground">Refund in your Stripe dashboard: a full refund stops the download link.</p>
						{output?.nextCursor && (
							<Button asChild variant="outline" size="sm">
								<Link href={`/orders?cursor=${encodeURIComponent(output.nextCursor)}`}>
									Older
									<ChevronRight data-icon="inline-end" />
								</Link>
							</Button>
						)}
					</div>
				</div>
			)}
		</>
	);
}
