"use client";

import { useState, useTransition } from "react";
import Image from "next/image";
import { Loader2, Search } from "lucide-react";
import { searchGifs } from "@/app/(app)/campaigns/actions";
import { Button } from "@/components/ui/button";
import { CHECKERBOARD } from "@/lib/checkerboard";

// GIFs from GIPHY for an issue, only where the server has a GIPHY key. A GIF is hotlinked from GIPHY, so nothing is uploaded;
// the results say they are powered by GIPHY, as its terms ask.
export default function PickerGif({ onSelect }) {
	const [query, setQuery] = useState("");
	const [result, setResult] = useState(null);
	const [error, setError] = useState(null);
	const [isSearching, startSearching] = useTransition();

	function search(offset, searched) {
		startSearching(async () => {
			const answer = await searchGifs(searched, offset);
			if (answer.error) return setError(answer.error);
			setError(null);
			setResult((current) => ({ query: searched, nextOffset: answer.nextOffset, giphyUrl: answer.giphyUrl, gifs: offset > 0 && current ? [...current.gifs, ...answer.gifs] : answer.gifs }));
		});
	}

	return (
		<div className="flex flex-col gap-3 px-4 pb-4">
			<form
				onSubmit={(event) => {
					event.preventDefault();
					if (query.trim()) search(0, query.trim());
				}}
				className="relative"
			>
				<Search aria-hidden="true" className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-muted-foreground" />
				<input
					value={query}
					onChange={(event) => setQuery(event.target.value)}
					placeholder="Search GIFs"
					aria-label="Search GIFs"
					maxLength={100}
					className="h-9 w-full rounded-lg border border-input bg-transparent pr-3 pl-8 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring"
				/>
			</form>
			{error && (
				<p role="alert" className="text-sm text-muted-foreground">
					{error}
				</p>
			)}
			{isSearching && !result && <Loader2 className="mx-auto my-6 size-5 animate-spin text-muted-foreground" />}
			{result?.gifs.length === 0 && <p className="py-4 text-center text-sm text-muted-foreground">No GIFs for &quot;{result.query}&quot;.</p>}
			{result?.gifs.length > 0 && (
				<div className="max-h-[min(22rem,48dvh)] overflow-y-auto overscroll-contain">
					<ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
						{result.gifs.map((gif) => (
							<li key={gif.id}>
								<button
									type="button"
									onClick={() => onSelect({ url: gif.url, width: gif.width, height: gif.height, alt: gif.title })}
									aria-label={gif.title || "GIF"}
									style={CHECKERBOARD}
									className="relative block aspect-[4/3] w-full overflow-hidden rounded-lg shadow-border outline-none transition-[box-shadow,opacity] duration-150 hover:shadow-border-hover focus-visible:ring-2 focus-visible:ring-ring"
								>
									<Image src={gif.thumbUrl} alt="" fill unoptimized sizes="180px" loading="lazy" className="object-cover" />
								</button>
							</li>
						))}
					</ul>
					{result.nextOffset !== null && (
						<div className="flex justify-center py-3">
							<Button type="button" variant="ghost" size="sm" disabled={isSearching} onClick={() => search(result.nextOffset, result.query)}>
								{isSearching && <Loader2 data-icon="inline-start" className="animate-spin" />}
								Show more
							</Button>
						</div>
					)}
				</div>
			)}
			<p className="text-xs text-muted-foreground">
				Powered by{" "}
				<a href={result?.giphyUrl ?? "https://giphy.com/"} target="_blank" rel="noreferrer" className="underline underline-offset-2">
					GIPHY
				</a>
				. The GIF loads from GIPHY when a reader opens the issue.
			</p>
		</div>
	);
}
