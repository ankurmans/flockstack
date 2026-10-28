import Image from "next/image";

// The newsletter's header image on its home page: the whole picture at its own shape, never cropped to one (a wordmark banner
// holds its name and its publisher line edge to edge), up to the height a 3:1 picture had before.
export default function ImageHeaderArchive({ src }) {
	return (
		<div className="mx-auto max-w-5xl px-5 pt-6">
			<Image
				src={src}
				alt=""
				width={1200}
				height={400}
				sizes="(min-width: 1024px) 1024px, 100vw"
				unoptimized
				priority
				className="block h-auto max-h-[22rem] w-full rounded-xl bg-muted object-cover outline -outline-offset-1 outline-black/10 dark:outline-white/10"
			/>
		</div>
	);
}
