import AvatarNewsletter from "@/components/AvatarNewsletter";
import ButtonSubscribe from "@/components/ButtonSubscribe";

// shopLink: { href, label } while the newsletter sells something.
export default function HeaderArchive({ newsletter, indexHref, shopLink = null }) {
	return (
		<header className="sticky top-0 z-30 border-b border-border/60 bg-background/80 backdrop-blur-md">
			<div className="mx-auto flex h-14 max-w-5xl items-center justify-between gap-4 px-5">
				<a href={indexHref} className="flex min-w-0 items-center gap-2.5 font-medium tracking-tight">
					<AvatarNewsletter newsletter={newsletter} size={28} />
					<span className="truncate">{newsletter.name}</span>
				</a>
				<div className="flex items-center gap-4">
					{shopLink && (
						<a href={shopLink.href} className="text-sm font-medium text-muted-foreground transition-colors duration-150 hover:text-foreground">
							{shopLink.label}
						</a>
					)}
					<ButtonSubscribe />
				</div>
			</div>
		</header>
	);
}
