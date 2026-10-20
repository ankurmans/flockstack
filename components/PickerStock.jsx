"use client";

import { useState, useTransition } from "react";
import Image from "next/image";
import { Loader2, Search } from "lucide-react";
import { pickStockPhoto, searchStock } from "@/app/(app)/campaigns/actions";
import { Button } from "@/components/ui/button";
import { CHECKERBOARD } from "@/lib/checkerboard";
import { toast } from "@/lib/toast";

// Unsplash photos for an issue. A photo is hotlinked from Unsplash and carries its credit into the issue; picking one tells
// Unsplash it was used, as its API rules require. Each result names its photographer, linking to their page.
export default function PickerStock({ onSelect }) {
	const [query, setQuery] = useState("");
	const [result, setResult] = useState(null);
	const [error, setError] = useState(null);
	const [pickingId, setPickingId] = useState(null);
	const [isSearching, startSearching] = useTransition();

	function search(page, searched) {
		startSearching(async () => {
			const answer = await searchStock(searched, page);
			if (answer.error) return setError(answer.error);
			setError(null);
			setResult((current) => ({ query: searched, page, totalPages: answer.totalPages, unsplashUrl: answer.unsplashUrl, photos: page > 1 && current ? [...current.photos, ...answer.photos] : answer.photos }));
		});
	}

	async function pick(photo) {
		setPickingId(photo.id);
		const answer = await pickStockPhoto(photo.id);
		setPickingId(null);
		if (answer.error) return toast.error(answer.error);
		onSelect({
			url: answer.url,
			width: answer.width,
			height: answer.height,
			alt: answer.description,
			credit: { photographer: answer.photographer, unsplashUrl: answer.unsplashUrl },
		});
	}

	return (
		<div className="flex flex-col gap-3 px-4 pb-4">
			<form
				onSubmit={(event) => {
					event.preventDefault();
					if (query.trim()) search(1, query.trim());
				}}
				className="relative"
			>
				<Search aria-hidden="true" className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-muted-foreground" />
				<input
					value={query}
					onChange={(event) => setQuery(event.target.value)}
					placeholder="Search free photos"
					aria-label="Search free photos"
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
			{result?.photos.length === 0 && <p className="py-4 text-center text-sm text-muted-foreground">No photos for &quot;{result.query}&quot;.</p>}
			{result?.photos.length > 0 && (
				<div className="max-h-[min(22rem,48dvh)] overflow-y-auto overscroll-contain">
					<ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
						{result.photos.map((photo) => (
							<li key={photo.id} className="flex flex-col gap-1">
								<button
									type="button"
									onClick={() => pick(photo)}
									disabled={Boolean(pickingId)}
									aria-label={photo.description || `Photo by ${photo.photographer.name}`}
									style={CHECKERBOARD}
									className="relative block aspect-[4/3] w-full overflow-hidden rounded-lg shadow-border outline-none transition-[box-shadow,opacity] duration-150 hover:shadow-border-hover focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
								>
									<Image src={photo.thumbUrl} alt="" fill unoptimized sizes="180px" loading="lazy" className="object-cover" />
									{pickingId === photo.id && (
										<span className="absolute inset-0 grid place-items-center bg-background/60">
											<Loader2 className="size-5 animate-spin" />
										</span>
									)}
								</button>
								<a href={photo.photographer.url} target="_blank" rel="noreferrer" className="truncate text-xs text-muted-foreground hover:text-foreground">
									{photo.photographer.name}
								</a>
							</li>
						))}
					</ul>
					{result.page < result.totalPages && (
						<div className="flex justify-center py-3">
							<Button type="button" variant="ghost" size="sm" disabled={isSearching} onClick={() => search(result.page + 1, result.query)}>
								{isSearching && <Loader2 data-icon="inline-start" className="animate-spin" />}
								Show more
							</Button>
						</div>
					)}
				</div>
			)}
			<p className="text-xs text-muted-foreground">
				Photos from{" "}
				{result ? (
					<a href={result.unsplashUrl} target="_blank" rel="noreferrer" className="underline underline-offset-2">
						Unsplash
					</a>
				) : (
					"Unsplash"
				)}
				. The photographer is credited under the picture.
			</p>
		</div>
	);
}
