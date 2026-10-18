import { formatPrice } from "@/lib/payments/config";
import { cn } from "@/lib/utils";

// A product in the newsletter's shop. A cover image is an https link the seller chose; it loads as a plain image.
export default function CardProduct({ product, href, className }) {
	return (
		<a href={href} className={cn("group flex flex-col gap-4", className)}>
			<div className="relative aspect-[1200/630] overflow-hidden rounded-xl bg-muted outline -outline-offset-1 outline-black/10 dark:outline-white/10">
				{product.imageUrl ? (
					// eslint-disable-next-line @next/next/no-img-element
					<img src={product.imageUrl} alt="" loading="lazy" className="size-full object-cover transition-transform duration-500 ease-[cubic-bezier(0.2,0,0,1)] motion-safe:group-hover:scale-[1.03]" />
				) : (
					<div className="grid size-full place-items-center bg-dots text-4xl font-semibold tracking-tight text-muted-foreground/60">{product.title.slice(0, 1).toUpperCase()}</div>
				)}
			</div>
			<div className="flex flex-col gap-1.5">
				<h3 className="text-lg leading-snug font-semibold tracking-tight text-balance decoration-foreground/30 underline-offset-4 group-hover:underline">{product.title}</h3>
				{product.description && <p className="line-clamp-2 text-muted-foreground text-pretty">{product.description}</p>}
				<p className="text-sm font-medium tabular-nums">{formatPrice(product.priceCents, product.currency)}</p>
			</div>
		</a>
	);
}
