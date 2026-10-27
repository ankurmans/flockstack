import { getReaderText } from "@/lib/reader-languages";
import AvatarNewsletter from "@/components/AvatarNewsletter";
import FormSubscribe from "@/components/FormSubscribe";
import { formatNumber } from "@/lib/format";

// A handful of readers makes weak social proof, so small lists get the name instead.
const MIN_READERS_SHOWN = 100;

export default function PitchSubscribe({ newsletter, readers, via = "website", titleAs: Title = "h2" }) {
	const t = getReaderText(newsletter);
	return (
		<div className="flex flex-col items-center text-center">
			<AvatarNewsletter newsletter={newsletter} size={48} className="rounded-xl" />
			<Title className="mt-4 text-xl font-semibold tracking-tight text-balance">
				{readers >= MIN_READERS_SHOWN
					? t("Join {count} readers", { count: formatNumber(readers) })
					: t("Subscribe to {name}", { name: newsletter.name })}
			</Title>
			{newsletter.description && (
				<p className="mt-2 max-w-sm text-muted-foreground text-pretty">{newsletter.description}</p>
			)}
			<FormSubscribe newsletterSlug={newsletter.slug} fields={newsletter.signupFields} via={via} className="mt-6 max-w-sm" />
			<p className="mt-3 text-xs text-muted-foreground">{t("Free. Unsubscribe anytime.")}</p>
		</div>
	);
}
