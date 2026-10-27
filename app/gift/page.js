import ProviderReaderLanguage from "@/components/ProviderReaderLanguage";
import { Link2Off } from "lucide-react";
import CardNotice from "@/components/CardNotice";
import FormGiftRedeem from "@/components/FormGiftRedeem";
import { readGiftForPage } from "@/lib/gifts";

// The URL carries the gift's token: keep it out of search results and referrer headers.
export const metadata = {
	title: "Your gift",
	robots: { index: false, follow: false },
	referrer: "no-referrer",
};

export default async function GiftPage({ searchParams }) {
	const { token } = await searchParams;
	const validToken = typeof token === "string" ? token : null;
	const gift = validToken ? await readGiftForPage(validToken).catch(() => null) : null;

	return (
		<ProviderReaderLanguage language={gift?.language ?? "en"}><main className="theme-neutral flex min-h-dvh items-center justify-center bg-background px-4 py-16">
			{gift ? (
				<FormGiftRedeem token={validToken} gift={gift} />
			) : (
				<CardNotice icon={Link2Off} title="This link doesn't work">
					Check that you opened the whole link from the email.
				</CardNotice>
			)}
		</main></ProviderReaderLanguage>
	);
}
