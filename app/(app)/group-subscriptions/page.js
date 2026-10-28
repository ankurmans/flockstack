import Link from "next/link";
import { randomUUID } from "node:crypto";
import { UsersRound } from "lucide-react";
import HeaderPage from "@/components/HeaderPage";
import StateEmpty from "@/components/StateEmpty";
import LayoutNarrow from "@/components/LayoutNarrow";
import FormGroupAction from "@/components/FormGroupAction";
import { Input } from "@/components/ui/input";
import { runDashboardAction } from "@/lib/actions/dashboard";
import { getSelectedNewsletter } from "@/lib/selected-newsletter";
import { saveGroupSettings, createCheckout } from "./actions.js";

export const metadata = { title: "Group subscriptions" };
export const dynamic = "force-dynamic";
export default async function GroupSubscriptionsPage({ searchParams }) {
	const { selected } = await getSelectedNewsletter();
	if (!selected) return <LayoutNarrow><HeaderPage title="Group subscriptions" /><p>Create a newsletter first.</p></LayoutNarrow>;
	const { cursor } = await searchParams;
	const newsletter = String(selected._id);
	const [settings, list] = await Promise.all([runDashboardAction("get_group_settings", { id: newsletter }), runDashboardAction("list_group_subscriptions", { newsletter, ...(typeof cursor === "string" && { cursor }) })]);
	return <LayoutNarrow><HeaderPage title="Group subscriptions" /><div className="flex flex-col gap-6">
		<p className="text-sm text-muted-foreground">One buyer pays per seat for {selected.name}. Readers join by accepting their own emailed invitations. Personal subscriptions stay unchanged.</p>
		{settings.failure && <p role="alert">{settings.failure.message}</p>}
		{settings.output && <section className="space-y-4 rounded-xl border p-5"><h2 className="font-semibold">Group purchases</h2><FormGroupAction action={saveGroupSettings} label="Save group settings"><input type="hidden" name="newsletter" value={newsletter} /><label className="flex items-center gap-2 text-sm"><input type="checkbox" name="enabled" defaultChecked={settings.output.enabled} />Open new group purchases</label></FormGroupAction><p className="text-sm text-muted-foreground">Closing purchases leaves existing group billing available. Regular monthly, quarterly and yearly tiers only; 2 to 100 seats.</p>{settings.output.enabled && <a href={settings.output.buyUrl} target="_blank" rel="noreferrer" className="text-sm underline">Open group purchase page</a>}
		{settings.output.enabled && <details className="text-sm"><summary className="cursor-pointer">Create a buyer checkout link</summary><div className="pt-4"><FormGroupAction action={createCheckout} label="Create Stripe checkout"><input type="hidden" name="newsletter" value={newsletter} /><input type="hidden" name="externalId" value={randomUUID()} /><label>Buyer email<Input name="email" type="email" required maxLength={320} /></label><label>Seats<Input name="seats" type="number" min={2} max={100} defaultValue={2} required /></label><label>Plan<select name="plan" className="mt-1 w-full rounded-md border bg-background p-2">{settings.output.plans.map(plan => <option key={`${plan.tierId}:${plan.option}`} value={`${plan.tierId}:${plan.option}`}>{plan.name} · {plan.option} · {plan.unitAmountCents} {plan.currency.toUpperCase()} minor units per seat</option>)}</select></label></FormGroupAction></div></details>}</section>}
		<section className="rounded-xl border p-5"><h2 className="mb-4 font-semibold">Groups</h2>{list.failure && <p role="alert">{list.failure.message}</p>}{list.output?.groups.length === 0 && <StateEmpty isCompact className="px-0" icon={UsersRound} title="No group checkouts yet" />}<ul className="divide-y">{list.output?.groups.map(group => <li key={group.id} className="py-3 text-sm"><Link className="font-medium underline" href={`/group-subscriptions/${group.id}`}>{group.buyerEmail}</Link><p className="mt-1 text-muted-foreground">{group.subscriptionStatus ?? group.status} · {group.capacity} funded seats · {group.seats.filter(seat => seat.status === "active").length} accepted</p></li>)}</ul>{list.output?.nextCursor && <Link className="mt-4 block text-sm underline" href={`/group-subscriptions?cursor=${encodeURIComponent(list.output.nextCursor)}`}>Next page</Link>}</section>
	</div></LayoutNarrow>;
}
