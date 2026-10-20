// The launch offer's line above a newsletter's website (lib/offers.js getLaunchBanner), linking to the offer's page.
export default function BannerOffer({ text, href }) {
	return (
		<a href={href} className="block bg-foreground px-4 py-2.5 text-center text-sm text-balance text-background transition-opacity duration-150 hover:opacity-90">
			{text}
		</a>
	);
}
