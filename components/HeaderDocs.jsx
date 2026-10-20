import { isCloud } from "@/lib/config";

// product: { href, label } for a FlockStack Cloud page of the marketing website that says what this part of the docs is for.
// A plain link, not a <Link>: the website is another program, so a click always loads it from the server (docs/ROUTING.md
// of the website). Self-hosted servers have no such page, and show nothing.
export default function HeaderDocs({ kicker, title, children, product }) {
	return (
		<header className="mb-10 max-w-2xl animate-enter">
			<p className="mb-3 font-mono text-[11px] tracking-wider text-muted-foreground uppercase">{kicker}</p>
			<h1 className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl">{title}</h1>
			{children && <div className="mt-4 text-[17px] leading-8 text-pretty text-muted-foreground">{children}</div>}
			{product && isCloud() && (
				<p className="mt-4 text-sm text-muted-foreground">
					What is this for?{" "}
					<a href={product.href} className="font-medium text-link underline decoration-link/30 underline-offset-4 hover:decoration-link">
						{product.label}
					</a>
				</p>
			)}
		</header>
	);
}
