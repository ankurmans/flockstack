import { Newspaper } from "lucide-react";
import { cn } from "@/lib/utils";

// A story's link preview on the owner's own pages: its page's og:image, loaded by the owner's browser straight from the publisher
// (never proxied or copied, and no referrer sent), or an icon when the page had none. Only https addresses are shown.
export default function ImageLinkPreview({ src, alt, size = 56, className }) {
	const isShown = /^https:\/\/[^\s"'<>]+$/.test(String(src ?? ""));
	return (
		<span style={{ width: size, height: size }} className={cn("grid shrink-0 place-items-center overflow-hidden rounded-lg bg-muted text-muted-foreground shadow-border", className)}>
			{isShown ? (
				// eslint-disable-next-line @next/next/no-img-element -- the publisher's own image, not ours to optimize or copy
				<img src={src} alt={alt} width={size} height={size} loading="lazy" decoding="async" referrerPolicy="no-referrer" className="size-full object-cover" />
			) : (
				<Newspaper className="size-5" aria-hidden="true" />
			)}
		</span>
	);
}
