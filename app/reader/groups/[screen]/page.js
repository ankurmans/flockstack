import { randomUUID } from "node:crypto";
import { notFound } from "next/navigation";
import FormGroupAction from "@/components/FormGroupAction";
import PanelGroupManagerBilling from "@/components/PanelGroupManagerBilling";
import { Input } from "@/components/ui/input";
import { getReaderText } from "@/lib/reader-languages";
import { connectDb } from "@/lib/db";
import { groupOutput } from "@/lib/group-output";
import { readGroupContext } from "@/lib/group-seats";
import { groupPlans } from "@/lib/group-subscriptions";
import { findOpenNewsletter } from "@/lib/public-newsletters";
import { acceptSeat, buyGroup, manageGroup, requestManagerEmail } from "../actions.js";

export const dynamic = "force-dynamic";
export const metadata = { title: "Group subscription", robots: { index: false, follow: false }, referrer: "no-referrer" };

export default async function PublicGroupPage({ params, searchParams }) {
	const { screen } = await params;
	if (!["buy", "complete", "invite", "manage"].includes(screen)) notFound();
	const query = await searchParams;
	await connectDb();
	if (screen === "buy" || screen === "complete") {
		const newsletter = await findOpenNewsletter({ slug: typeof query.newsletter === "string" ? query.newsletter.slice(0, 100) : "" });
		if (!newsletter) notFound();
		const t = getReaderText(newsletter), plans = groupPlans(newsletter);
		return <Shell language={t.language}><h1 className="text-2xl font-semibold">{t(screen === "complete" ? "Check your email" : "Group subscription")}</h1><p>{newsletter.name}</p><p className="text-sm text-muted-foreground">{t(screen === "complete" ? "Stripe confirms payment separately. A private management link is emailed to the verified buyer. No reader is subscribed automatically." : "One buyer pays per seat. Each reader must accept their own invitation. Individual subscriptions stay unchanged.")}</p>
			{screen === "buy" && newsletter.groupSubscriptions?.enabled && plans.length > 0 && <FormGroupAction action={buyGroup} label={t("Continue to Stripe")} language={t.language}><input type="hidden" name="newsletter" value={newsletter.slug} /><input type="hidden" name="externalId" value={randomUUID()} /><label>{t("Buyer email")}<Input name="email" type="email" required maxLength={320} /></label><label>{t("Seats")}<Input name="seats" type="number" min={2} max={100} defaultValue={2} required /></label><label>{t("Plan")}<select name="plan" className="mt-1 w-full rounded-md border bg-background p-2">{plans.map(plan => <option key={`${plan.tierId}:${plan.option}`} value={`${plan.tierId}:${plan.option}`}>{plan.name} · {t(plan.option === "month" ? "Monthly" : plan.option === "quarter" ? "Quarterly" : "Yearly")} · {t("{amount} {currency} minor units per seat", { amount: plan.unitAmountCents, currency: plan.currency.toUpperCase() })}</option>)}</select></label></FormGroupAction>}
			<section className="space-y-3 border-t pt-5"><h2 className="font-semibold">{t("Already bought a group?")}</h2><FormGroupAction action={requestManagerEmail} label={t("Email my management link")} language={t.language}><input type="hidden" name="newsletter" value={newsletter.slug} /><label>{t("Buyer email")}<Input name="email" type="email" required maxLength={320} /></label></FormGroupAction></section>
		</Shell>;
	}
	const token = typeof query.token === "string" ? query.token : "";
	let context;
	try { context = await readGroupContext(token, screen === "invite" ? "seat" : "manager"); }
	catch (error) { if (error.code !== "not_found") throw error; return <Shell><h1 className="text-xl font-semibold">This link expired or is no longer available</h1><p>Ask the buyer or creator for a new email.</p></Shell>; }
	const t = getReaderText(context.newsletter);
	if (screen === "invite") return <Shell language={t.language}><h1 className="text-2xl font-semibold">{t("Accept your group seat")}</h1><p>{context.newsletter.name}</p><p className="text-sm text-muted-foreground">{t("Accepting subscribes the invited address to this newsletter. It gives paid access while the group funds your seat. It does not cancel any individual subscription.")}</p><FormGroupAction action={acceptSeat} label={t("Subscribe and accept seat")} language={t.language}><input type="hidden" name="token" value={token} /><label>{t("Invited email")}<Input name="email" type="email" autoComplete="email" required maxLength={320} /></label><label className="flex items-start gap-2 text-sm"><input type="checkbox" name="subscribe" required className="mt-1" />{t("I agree to subscribe and accept this group seat.")}</label></FormGroupAction></Shell>;
	const group = groupOutput(context.group);
	const hidden = operation => <><input type="hidden" name="token" value={token} /><input type="hidden" name="operation" value={operation} /></>;
	return <Shell language={t.language}><h1 className="text-2xl font-semibold">{t("Manage your group")}</h1><p>{context.newsletter.name} · {group.buyerEmail}</p><p className="text-sm">{t("{count} funded seats", { count: group.capacity })} · {group.subscriptionStatus ?? group.status}</p><p className="text-sm text-muted-foreground">{t("Funded until: {date}", { date: group.paidUntil ?? t("Unknown") })}</p><FormGroupAction action={manageGroup} label={t("Refresh billing")} language={t.language}>{hidden("refresh")}</FormGroupAction>
		<section className="space-y-4 border-t pt-5"><h2 className="font-semibold">{t("Reader seats")}</h2><FormGroupAction action={manageGroup} label={t("Email seat invitation")} language={t.language}>{hidden("invite")}<label>{t("Reader email")}<Input name="email" type="email" required maxLength={320} /></label></FormGroupAction><ul className="divide-y">{group.seats.map(seat => <li className="space-y-2 py-3 text-sm" key={seat.id}><p>{seat.email ?? t("Deleted reader")} · {t(seat.status === "invited" ? "Invited" : seat.status === "accepting" ? "Acceptance in progress" : seat.status === "active" ? "Accepted" : "Revoked")}</p>{seat.status !== "revoked" && <FormGroupAction action={manageGroup} label={t("Revoke seat")} language={t.language}>{hidden("revoke")}<input type="hidden" name="seatId" value={seat.id} /></FormGroupAction>}</li>)}</ul></section><PanelGroupManagerBilling token={token} action={manageGroup} language={t.language} />
	</Shell>;
}
function Shell({ children, language = "en" }) { return <main lang={language} className="theme-neutral min-h-dvh bg-background px-5 py-16"><div className="mx-auto flex max-w-xl flex-col gap-5">{children}</div></main>; }
