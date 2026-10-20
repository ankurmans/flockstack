import { notFound } from "next/navigation";
import AvatarNewsletter from "@/components/AvatarNewsletter";
import LinksSocial from "@/components/LinksSocial";
import { getArchiveNewsletter } from "@/lib/archive-data";
import { getArchiveUrls } from "@/lib/archive-hosts";
import { getShopMetadata } from "@/lib/archive-seo";
import { isExternal, toLinkPage } from "@/lib/link-page";

export const revalidate = 3600;

export function generateStaticParams() {
	return [];
}

async function getLinkPage(params) {
	const newsletter = await getArchiveNewsletter((await params).slug);
	return newsletter?.linkPage?.enabled ? { newsletter, page: toLinkPage(newsletter) } : null;
}

export async function generateMetadata({ params }) {
	const found = await getLinkPage(params);
	if (!found) return {};
	const { newsletter, page } = found;
	return getShopMetadata(newsletter, {
		title: `${page.title || newsletter.name} · Links`,
		description: page.bio || `Links from ${newsletter.name}.`,
		url: getArchiveUrls(newsletter).absoluteLinks,
	});
}

// The newsletter's link-in-bio page: what its writer lists, as buttons, with the way to subscribe first.
export default async function LinksPage({ params }) {
	const found = await getLinkPage(params);
	if (!found) notFound();
	const { newsletter, page } = found;
	const urls = getArchiveUrls(newsletter);

	return (
		<div className="mx-auto flex max-w-md flex-col items-center px-5 pt-14 pb-24 text-center sm:pt-20">
			<AvatarNewsletter newsletter={newsletter} size={88} className="rounded-full shadow-[0_8px_24px_-8px_rgb(0_0_0/0.25)] animate-enter" />
			<h1 style={{ "--stagger": 1 }} className="mt-5 text-3xl font-semibold tracking-tight text-balance animate-enter">
				{page.title || newsletter.name}
			</h1>
			{page.bio && (
				<p style={{ "--stagger": 2 }} className="mt-3 text-base text-muted-foreground text-balance animate-enter">
					{page.bio}
				</p>
			)}
			<ul style={{ "--stagger": 3 }} className="mt-8 flex w-full flex-col gap-3 animate-enter">
				<li>
					<a href={`${urls.index}#subscribe`} className="block rounded-xl bg-foreground px-4 py-3.5 text-sm font-medium text-background transition-opacity duration-150 hover:opacity-90">
						Subscribe to {newsletter.name}
					</a>
				</li>
				{page.links.map(({ label, url }) => (
					<li key={`${label}:${url}`}>
						<a
							href={url}
							{...(isExternal(url) && { target: "_blank", rel: "noopener noreferrer" })}
							className="block rounded-xl bg-card px-4 py-3.5 text-sm font-medium shadow-border transition-[box-shadow,transform] duration-150 hover:shadow-border-hover active:scale-[0.99]"
						>
							{label}
						</a>
					</li>
				))}
			</ul>
			<div style={{ "--stagger": 4 }} className="mt-8 animate-enter">
				<LinksSocial links={newsletter.socialLinks} />
			</div>
		</div>
	);
}
