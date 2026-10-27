import { getReaderText } from "@/lib/reader-languages";
import { randomUUID } from "node:crypto";
import { notFound } from "next/navigation";
import { scoped } from "@/lib/account-scope";
import { getArchiveNewsletter } from "@/lib/archive-data";
import { findOpenNewsletter } from "@/lib/public-newsletters";
import { currentSponsorshipAccount } from "@/lib/sponsorship-bookings";
import { publicSponsorshipSlots } from "@/lib/sponsorship-inventory";
import { formatPrice } from "@/lib/payments/config";
import FormSponsorshipAction from "@/components/FormSponsorshipAction";
import { Input } from "@/components/ui/input";
import { makeSponsorRequest, recoverSponsorLink } from "@/app/reader/sponsorships/actions";
import SponsorshipPlacement from "@/models/SponsorshipPlacement";

export const dynamic = "force-dynamic";
export const metadata = { title: "Sponsor this newsletter" };
export default async function SponsorStorefront({ params }) {
	const site = await getArchiveNewsletter((await params).slug);
	const newsletter = site && await findOpenNewsletter({ _id: site._id });
	if (!newsletter?.archiveEnabled || !newsletter.sponsorships?.enabled) notFound();
	const t = getReaderText(newsletter);
	const account = await currentSponsorshipAccount(newsletter.accountId);
	const placements = await SponsorshipPlacement.find(scoped(account, { newsletterId: newsletter._id, archived: false })).limit(10).lean();
	const slots = await publicSponsorshipSlots(account, newsletter, placements);
	return <main className="mx-auto flex max-w-2xl flex-col gap-6 px-5 py-12"><h1 className="text-3xl font-semibold">{t("Sponsor")} {newsletter.name}</h1><p>{t("Choose a placement and planned day. Confirm your email, then the creator reviews your request and sends an invoice through their own Stripe account. Your request reserves no date and subscribes you to no newsletter.")}</p><ul className="divide-y">{placements.map(placement => <li key={String(placement._id)} className="space-y-2 py-4"><h2 className="font-semibold">{placement.name}</h2><p className="whitespace-pre-wrap text-sm">{placement.description}</p><p className="text-sm">{t("Standard placement:")} {formatPrice(placement.amountMinor, placement.currency)}{t(". Each date shows its agreed price below.")}</p></li>)}</ul>{slots.length ? <FormSponsorshipAction language={t.language} action={makeSponsorRequest} label={t("Email me a confirmation link")}><input type="hidden" name="newsletter" value={newsletter.slug} /><input type="hidden" name="externalId" value={randomUUID()} /><label className="text-sm">{t("Placement and planned day")}<select name="slotId" className="mt-1 w-full rounded-md border bg-background p-2" required>{slots.map(slot => <option key={String(slot._id)} value={String(slot._id)}>{slot.placementName} · {slot.day} ({slot.timeZone}) · {formatPrice(slot.amountMinor, slot.currency)}</option>)}</select></label><label className="text-sm">{t("Brand name")}<Input name="brandName" required maxLength={120} /></label><label className="text-sm">{t("Your sponsor email")}<Input type="email" name="email" required maxLength={320} /></label></FormSponsorshipAction> : <p>{t("No placement dates are open right now.")}</p>}<p className="text-sm text-muted-foreground">{t("Dates are commercial plans. Payment does not schedule or send an issue. Creative requires the owner’s approval. The creator handles any cancellation or refund.")}</p><details className="border-t pt-5"><summary className="cursor-pointer text-sm">{t("Recover a confirmed request")}</summary><div className="pt-4"><FormSponsorshipAction language={t.language} action={recoverSponsorLink} label={t("Email my management link")}><input type="hidden" name="newsletterId" value={String(newsletter._id)} /><label className="text-sm">{t("Booking ID")}<Input name="bookingId" required maxLength={24} /></label><label className="text-sm">{t("Sponsor email")}<Input type="email" name="email" required maxLength={320} /></label></FormSponsorshipAction></div></details></main>;
}
