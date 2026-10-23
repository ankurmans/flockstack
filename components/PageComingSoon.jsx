import Image from "next/image";
import AvatarNewsletter from "@/components/AvatarNewsletter";
import FormSubscribe from "@/components/FormSubscribe";
import LinksSocial from "@/components/LinksSocial";
import { getBrand } from "@/lib/brand";

// A newsletter's home page before its first issue has gone out: its name, logo and description, "First issue coming soon" and
// the signup form, in its theme and brand, with no empty list of issues. Search engines are asked to wait
// (lib/archive-seo.js getComingSoonSeo).
export default function PageComingSoon({ newsletter, signupFields }) {
	const brand = getBrand(newsletter);

	return (
		<>
			{brand.headerUrl && (
				<div className="mx-auto max-w-5xl px-5 pt-6">
					<div className="relative aspect-[3/1] overflow-hidden rounded-xl bg-muted outline -outline-offset-1 outline-black/10 dark:outline-white/10">
						<Image src={brand.headerUrl} alt="" fill sizes="(min-width: 1024px) 1024px, 100vw" unoptimized priority className="object-cover" />
					</div>
				</div>
			)}
			<section data-coming-soon className="site-hero relative isolate overflow-hidden">
				<div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[34rem] bg-dots" />
				<div className="site-hero-inner mx-auto flex max-w-2xl flex-col items-center px-5 pt-16 pb-24 text-center sm:pt-24 sm:pb-32">
					<AvatarNewsletter newsletter={newsletter} size={72} className="rounded-2xl shadow-[0_8px_24px_-8px_rgb(0_0_0/0.25)] animate-enter" />
					<h1 style={{ "--stagger": 1 }} className="site-title mt-6 text-4xl font-semibold tracking-tight animate-enter sm:text-5xl">
						{newsletter.name}
					</h1>
					{newsletter.description && (
						<p style={{ "--stagger": 2 }} className="mt-4 max-w-xl text-lg text-muted-foreground text-balance animate-enter">
							{newsletter.description}
						</p>
					)}
					<p style={{ "--stagger": 3 }} className="mt-6 inline-flex h-7 items-center gap-2 rounded-full px-3 text-sm font-medium text-muted-foreground shadow-border animate-enter">
						<span aria-hidden="true" className="size-1.5 rounded-full bg-emerald-500" />
						First issue coming soon
					</p>
					<div id="subscribe" style={{ "--stagger": 4 }} className="mt-8 w-full max-w-md scroll-mt-24 animate-enter">
						<FormSubscribe newsletterSlug={newsletter.slug} fields={signupFields} />
					</div>
					<p style={{ "--stagger": 5 }} className="mt-4 text-sm text-muted-foreground animate-enter">
						Subscribe and it arrives in your inbox the day it goes out. Free, unsubscribe anytime.
					</p>
					<div style={{ "--stagger": 6 }} className="mt-4 animate-enter">
						<LinksSocial links={newsletter.socialLinks} />
					</div>
				</div>
			</section>
		</>
	);
}
