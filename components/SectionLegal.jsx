// One part of a legal page. The id makes it linkable (/terms#acceptable-use).
export default function SectionLegal({ id, title, children }) {
	return (
		<section id={id} aria-labelledby={`${id}-title`} className="mt-12 scroll-mt-20 first-of-type:mt-0">
			<h2 id={`${id}-title`} className="mb-3 text-xl font-semibold tracking-tight">
				{title}
			</h2>
			<div className="flex flex-col gap-4 text-[15px] leading-7 text-pretty text-foreground/80 [&_ul]:flex [&_ul]:list-disc [&_ul]:flex-col [&_ul]:gap-2 [&_ul]:pl-5 [&_ul]:marker:text-muted-foreground">
				{children}
			</div>
		</section>
	);
}
