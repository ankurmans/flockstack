import { getReaderText } from "@/lib/reader-languages";
import Link from "next/link";
import { notFound } from "next/navigation";
import { scoped } from "@/lib/account-scope";
import { readSponsorshipContext } from "@/lib/sponsorship-bookings";
import { sponsorshipAssetOutput } from "@/lib/sponsorship-assets";
import { sponsorshipBookingOutput, sponsorshipInvoiceOutput } from "@/lib/sponsorship-output";
import { getSponsorshipReport } from "@/lib/sponsorship-reports";
import { formatPrice } from "@/lib/payments/config";
import { getArchiveUrls } from "@/lib/archive-hosts";
import FormSponsorshipAction from "@/components/FormSponsorshipAction";
import FormSponsorshipUpload from "@/components/FormSponsorshipUpload";
import FieldsSponsorCreative from "@/components/FieldsSponsorCreative";
import PanelSponsorshipReport from "@/components/PanelSponsorshipReport";
import SponsorshipAsset from "@/models/SponsorshipAsset";
import { confirmSponsorRequest, manageSponsorship } from "../actions.js";

export const dynamic = "force-dynamic";
export const metadata = { title: "Your sponsorship", robots: { index: false, follow: false }, referrer: "no-referrer" };
export default async function SponsorReaderPage({ params, searchParams }) {
	let t = getReaderText("en");
	const { screen } = await params, query = await searchParams;
	if (!["verify", "manage"].includes(screen)) notFound();
	const token = typeof query.token === "string" ? query.token : "";
	let context;
	try { context = await readSponsorshipContext(token, screen === "verify" ? "verify" : "manager"); }
	catch (error) { if (error.code !== "not_found") throw error; return <Shell language={t.language}><h1 className="text-2xl font-semibold">{t("This link expired or is no longer available")}</h1><p>{t("Use the creator’s sponsor page to request a fresh management email for a confirmed booking. You’ll need your booking ID and sponsor email.")}</p></Shell>; }
	const { account, newsletter } = context, booking = sponsorshipBookingOutput(context.booking);
	t = getReaderText(newsletter);
	if (screen === "verify") return <Shell language={t.language}><h1 className="text-2xl font-semibold">{t("Confirm your sponsorship request")}</h1><p>{newsletter.name} · {booking.placementName}</p><p>{booking.day} ({booking.timeZone}) · {formatPrice(booking.amountMinor, booking.currency)}</p><p>{t("This confirms control of")} {booking.email}{t(". It requests the creator’s review, reserves no date, creates no invoice and does not subscribe you.")}</p><FormSponsorshipAction language={t.language} action={confirmSponsorRequest} label={t("Confirm my request")}><input type="hidden" name="token" value={token} /></FormSponsorshipAction></Shell>;
	const [assetRows, report] = await Promise.all([SponsorshipAsset.find(scoped(account, { newsletterId: newsletter._id, bookingId: context.booking._id, status: { $ne: "deleted" } })).limit(5).lean(), getSponsorshipReport({ account, bookingId: booking.id, ...(typeof query.cursor === "string" && { cursor: query.cursor }) })]);
	const assets = assetRows.map(sponsorshipAssetOutput), invoice = sponsorshipInvoiceOutput(context.booking);
	const hidden = operation => <><input type="hidden" name="token" value={token} /><input type="hidden" name="operation" value={operation} /></>;
	return <Shell language={t.language}><h1 className="text-2xl font-semibold">{t("Your sponsorship with")} {newsletter.name}</h1><p>{booking.brandName} · {booking.status}</p><p className="text-sm">{booking.placementName} · {booking.day} ({booking.timeZone}) · {formatPrice(booking.amountMinor, booking.currency)}</p><p className="text-sm">{t("Booking ID:")} <code>{booking.id}</code></p><p className="text-sm text-muted-foreground">{t("Keep this link private. A planned day does not mean an issue was scheduled or sent.")}</p>
		<section className="space-y-3 border-t pt-5"><h2 className="font-semibold">{t("Invoice")}</h2><p className="text-sm">{t("Last observed status:")} {invoice.status ?? t("Not created")}</p>{invoice.observedAt && <p className="text-sm text-muted-foreground">{t("Observed")} {invoice.observedAt}</p>}{invoice.hostedUrl && <a href={invoice.hostedUrl} rel="noreferrer" className="block text-sm underline">{t("Review invoice in Stripe")}</a>}{invoice.pdfUrl && <a href={invoice.pdfUrl} rel="noreferrer" className="block text-sm underline">{t("Download invoice from Stripe")}</a>}{invoice.id && <FormSponsorshipAction language={t.language} action={manageSponsorship} label={t("Refresh invoice")}>{hidden("refresh")}</FormSponsorshipAction>}{invoice.problem && <p role="alert" className="text-sm">{invoice.problem}</p>}<p className="text-sm text-muted-foreground">{t("Payment does not send an issue. The creator reviews cancellation or refund requests; withdrawing here does not issue a refund.")}</p></section>
		{booking.status !== "canceled" && <section className="space-y-5 border-t pt-5"><h2 className="font-semibold">{t("Sponsor creative")}</h2>{booking.campaignId ? <><h3 className="font-medium">{booking.creative?.headline}</h3><p className="whitespace-pre-wrap text-sm">{booking.creative?.body}</p><p className="text-sm">{t("Attached to an issue. Ask the creator about any changes.")}</p></> : <><FormSponsorshipUpload language={t.language} bookingId={booking.id} token={token} /><FormSponsorshipAction language={t.language} key={booking.creativeHash ?? "empty"} action={manageSponsorship} label={t("Save creative for owner review")}>{hidden("creative")}<FieldsSponsorCreative language={t.language} creative={booking.creative} assets={assets} /></FormSponsorshipAction></>}<p className="text-sm">{booking.approvedCreativeHash && booking.approvedCreativeHash === booking.creativeHash ? t("The owner approved this version.") : t("The current version awaits the owner’s review.")}</p>{assets.map(asset => <div key={asset.id} className="space-y-3 border-t pt-3"><p className="text-sm">{asset.fileName} · {asset.publicAt ? t("Approved public image") : t("Private image")}</p>{asset.status === "ready" && <FormSponsorshipAction language={t.language} action={manageSponsorship} label={t("Preview image")}>{hidden("preview")}<input type="hidden" name="assetId" value={asset.id} /></FormSponsorshipAction>}{!asset.publicAt && <FormSponsorshipAction language={t.language} action={manageSponsorship} label={t("Remove unused private image")}>{hidden("remove")}<input type="hidden" name="assetId" value={asset.id} /></FormSponsorshipAction>}</div>)}</section>}
		<PanelSponsorshipReport language={t.language} report={report} />{report.nextCursor && <Link href={`/reader/sponsorships/manage?token=${encodeURIComponent(token)}&cursor=${encodeURIComponent(report.nextCursor)}`} className="text-sm underline">{t("More issue observations")}</Link>}
		{!invoice.id && booking.status !== "canceled" && <FormSponsorshipAction language={t.language} action={manageSponsorship} label={t("Withdraw unbilled request")}>{hidden("withdraw")}<p className="text-sm">{t("Withdrawal is available until invoicing starts. After that, contact the creator. This does not issue a refund.")}</p></FormSponsorshipAction>}<a href={getArchiveUrls(newsletter).absoluteSponsor} rel="noreferrer" className="text-sm underline">{t("Sponsor page and management-link recovery")}</a>
	</Shell>;
}
function Shell({ children, language = "en" }) { return <main lang={language} className="theme-neutral min-h-dvh bg-background px-5 py-14"><div className="mx-auto flex max-w-2xl flex-col gap-5">{children}</div></main>; }
