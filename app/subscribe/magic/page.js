import { headers } from "next/headers";
import { Link2Off } from "lucide-react";
import CardNotice from "@/components/CardNotice";
import FormMagic from "@/components/FormMagic";
import { readUtm, toReferrerHost } from "@/lib/attribution";
import { isLikelyBot } from "@/lib/bots";
import { getNewsletterHost } from "@/lib/archive-hosts";
import { getAppHost } from "@/lib/config";
import { resolveArchiveHost } from "@/lib/host-routing";
import { MAGIC_MESSAGES, checkMagicLink, readMagicEmail } from "@/lib/magic-links";
import { findSignupNewsletter } from "@/lib/public-newsletters";

// The address of the reader is in the URL: keep it out of search results and referrer headers.
export const metadata = {
	title: "Subscribe",
	robots: { index: false, follow: false },
	referrer: "no-referrer",
};

export const dynamic = "force-dynamic";

const first = (value) => (Array.isArray(value) ? value[0] : value);

// A Magic Link, on the newsletter's own host: the other platform's reader lands here with their address filled in.
export default async function MagicLinkPage({ searchParams }) {
	const [query, requestHeaders] = await Promise.all([searchParams, headers()]);
	const { slug: hostSlug } = await resolveArchiveHost(requestHeaders.get("host"));
	const slug = hostSlug || String(first(query.n) ?? "").toLowerCase();
	const newsletter = slug ? await findSignupNewsletter({ slug }).catch(() => null) : null;
	const status = newsletter ? checkMagicLink(newsletter, { keyId: first(query.k), signature: first(query.sig) }) : "invalid";
	if (status !== "valid") {
		return (
			<main className="theme-neutral flex min-h-dvh items-center justify-center bg-background px-4 py-16">
				<CardNotice icon={Link2Off} title="This link doesn't work">
					{MAGIC_MESSAGES[status]}
				</CardNotice>
			</main>
		);
	}

	const utm = readUtm((name) => first(query[name]));
	return (
		<main className="theme-neutral flex min-h-dvh items-center justify-center bg-background px-4 py-16">
			<FormMagic
				newsletterName={newsletter.name}
				slug={newsletter.slug}
				keyId={String(first(query.k))}
				signature={String(first(query.sig))}
				email={readMagicEmail(first(query.email)) ?? ""}
				utm={Object.fromEntries(Object.entries(utm ?? {}).map(([key, value]) => [`utm_${key}`, value]))}
				from={toReferrerHost(requestHeaders.get("referer"), [getNewsletterHost(newsletter), getAppHost()]) ?? ""}
				isAutomatic={!isLikelyBot(requestHeaders.get("user-agent"))}
			/>
		</main>
	);
}
