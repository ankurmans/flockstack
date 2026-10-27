import Link from "next/link";
import HeaderPage from "@/components/HeaderPage";
import LayoutNarrow from "@/components/LayoutNarrow";
import FormGroupAction from "@/components/FormGroupAction";
import PanelGroupInvoices from "@/components/PanelGroupInvoices";
import { Input } from "@/components/ui/input";
import { runDashboardAction } from "@/lib/actions/dashboard";
import { refreshGroup, inviteSeat, revokeSeat, emailManager, readInvoices, openGroupBilling } from "../actions.js";

export const metadata = { title: "Group subscription" };
export const dynamic = "force-dynamic";
export default async function GroupPage({ params }) {
	const { id } = await params;
	const { output: group, failure } = await runDashboardAction("get_group_subscription", { id });
	return <LayoutNarrow><HeaderPage title="Group subscription" /><div className="flex flex-col gap-6"><Link href="/group-subscriptions" className="text-sm underline">All groups</Link>{failure && <p role="alert">{failure.message}</p>}{group && <>
		<section className="space-y-4 rounded-xl border p-5"><h2 className="font-semibold">{group.buyerEmail}</h2><p className="text-sm">{group.subscriptionStatus ?? group.status} · {group.capacity} funded seats · {group.tierId} · {group.option}</p><p className="text-sm text-muted-foreground">Funded until {group.paidUntil ?? "payment is verified"}. Last billing read: {group.observedAt ?? "Not yet read"}.</p>{group.billingProblem && <p role="alert" className="text-sm text-destructive">{group.billingProblem}</p>}<FormGroupAction action={refreshGroup} label="Refresh billing from Stripe"><input type="hidden" name="id" value={id} /></FormGroupAction><FormGroupAction action={emailManager} label="Email buyer a management link"><input type="hidden" name="id" value={id} /><label className="flex items-center gap-2 text-sm"><input type="checkbox" name="rotate" />Revoke all older management links</label></FormGroupAction></section>
		<section className="space-y-4 rounded-xl border p-5"><h2 className="font-semibold">Reader seats</h2><p className="text-sm text-muted-foreground">An invitation reserves a funded seat. It grants access only after its recipient agrees to subscribe. Revoking a seat keeps their newsletter signup and personal billing.</p><FormGroupAction action={inviteSeat} label="Email seat invitation"><input type="hidden" name="id" value={id} /><label className="text-sm">Reader email<Input name="email" type="email" required maxLength={320} /></label></FormGroupAction><ul className="divide-y">{group.seats.map(seat => <li key={seat.id} className="flex flex-wrap items-start justify-between gap-4 py-3 text-sm"><div><p>{seat.email ?? "Deleted reader"}</p><p className="text-muted-foreground">{seat.status}{seat.status !== "revoked" && !seat.withinPaidCapacity ? " · outside current paid capacity" : ""}{seat.status === "invited" && !seat.invitationSentAt ? " · invitation email not sent" : ""}</p></div>{seat.status !== "revoked" && <FormGroupAction action={revokeSeat} label="Revoke seat"><input type="hidden" name="id" value={id} /><input type="hidden" name="seatId" value={seat.id} /></FormGroupAction>}</li>)}</ul></section>
		<PanelGroupInvoices load={readInvoices.bind(null, id)} openBilling={openGroupBilling.bind(null, id)} />
	</>}</div></LayoutNarrow>;
}
