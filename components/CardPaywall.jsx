import { Lock } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// The end of a paid issue's teaser on the web: the rest is in paid subscribers' email. href: the subscribe page, or null
// while the newsletter isn't taking paid subscribers. isPartial: the writer put a paywall break in an issue for
// everyone, so only the part after it is for paid subscribers.
export default function CardPaywall({ newsletterName, href, isPartial = false }) {
	return (
		<div className="relative mt-2">
			<div aria-hidden="true" className="pointer-events-none absolute inset-x-0 -top-24 h-24 bg-gradient-to-t from-background to-transparent" />
			<div className="flex flex-col items-center gap-3 rounded-2xl bg-card px-6 py-10 text-center shadow-border">
				<span className="grid size-10 place-items-center rounded-xl bg-muted text-muted-foreground">
					<Lock className="size-5" aria-hidden="true" />
				</span>
				<h2 className="text-xl font-semibold tracking-tight text-balance">
					{isPartial ? "The rest of this issue is for paid subscribers" : "This issue is for paid subscribers"}
				</h2>
				<p className="max-w-sm text-muted-foreground text-pretty">
					{href
						? `Subscribe to read the rest. Paid subscribers get every issue of ${newsletterName} by email.`
						: `The full issue went to ${newsletterName}'s paid subscribers by email.`}
				</p>
				{href && (
					<a href={href} className={cn(buttonVariants({ size: "lg" }), "mt-2 h-11 rounded-xl px-6")}>
						Become a paid subscriber
					</a>
				)}
			</div>
		</div>
	);
}
