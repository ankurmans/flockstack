import Link from "next/link";

// A link inside a paragraph. Addresses on other sites and mailto: links are plain anchors.
export default function LinkInline({ href, children }) {
	const className = "font-medium text-foreground underline decoration-foreground/30 underline-offset-4 hover:decoration-foreground";
	if (/^(https?:|mailto:)/.test(href)) {
		return (
			<a href={href} className={className} {...(href.startsWith("http") && { target: "_blank", rel: "noopener" })}>
				{children}
			</a>
		);
	}
	return (
		<Link href={href} className={className}>
			{children}
		</Link>
	);
}
