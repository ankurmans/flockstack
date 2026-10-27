"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { CROP_RATIOS, MIN_CROP_SIDE, changeCropRatio, dragCropCorner, getInitialCrop, moveCrop } from "@/lib/image-edit";
import { cropToFile, loadCropSource } from "@/lib/image-crop-client";
import { uploadImage } from "@/lib/upload-image";
import { cn } from "@/lib/utils";

const KEY_STEP = 10;
const CORNERS = [
	{ id: "nw", className: "-top-1.5 -left-1.5 cursor-nwse-resize", label: "Top left corner" },
	{ id: "ne", className: "-top-1.5 -right-1.5 cursor-nesw-resize", label: "Top right corner" },
	{ id: "sw", className: "-bottom-1.5 -left-1.5 cursor-nesw-resize", label: "Bottom left corner" },
	{ id: "se", className: "-right-1.5 -bottom-1.5 cursor-nwse-resize", label: "Bottom right corner" },
];

// Crops a picture of the issue: pick a shape, drag the box, and the part inside becomes a new picture in the media library,
// which replaces this one in the issue. The original stays where it was uploaded. onCropped({ url, width, height }).
export default function DialogImageCrop({ src, open, onOpenChange, onCropped }) {
	return open && src ? <CropDialog key={src} src={src} onOpenChange={onOpenChange} onCropped={onCropped} /> : null;
}

// Mounted per picture, so every crop starts fresh.
function CropDialog({ src, onOpenChange, onCropped }) {
	const [source, setSource] = useState(null);
	const [previewUrl, setPreviewUrl] = useState(null);
	const [error, setError] = useState(null);
	const [ratioId, setRatioId] = useState("free");
	const [rect, setRect] = useState(null);
	const [scale, setScale] = useState(1);
	const [isSaving, setIsSaving] = useState(false);
	const imageRef = useRef(null);
	const dragRef = useRef(null);
	const ratio = CROP_RATIOS.find(({ id }) => id === ratioId)?.ratio ?? null;
	const size = source ? { width: source.bitmap.width, height: source.bitmap.height } : null;

	useEffect(() => {
		let isCurrent = true;
		let url = null;
		loadCropSource(src)
			.then((loaded) => {
				if (!isCurrent) return;
				url = URL.createObjectURL(loaded.blob);
				setPreviewUrl(url);
				setSource(loaded);
				setRect(getInitialCrop({ width: loaded.bitmap.width, height: loaded.bitmap.height }));
			})
			.catch((failure) => isCurrent && setError(failure.message));
		return () => {
			isCurrent = false;
			if (url) URL.revokeObjectURL(url);
		};
	}, [src]);

	function measure() {
		if (imageRef.current && size) setScale(imageRef.current.clientWidth / size.width);
	}

	function choose(id) {
		setRatioId(id);
		const next = CROP_RATIOS.find((choice) => choice.id === id)?.ratio ?? null;
		setRect((current) => (current && size ? changeCropRatio(current, next, size) : current));
	}

	function startDrag(event, kind) {
		event.preventDefault();
		event.stopPropagation();
		event.currentTarget.setPointerCapture(event.pointerId);
		dragRef.current = { kind, x: event.clientX, y: event.clientY, rect };
	}

	function drag(event) {
		const start = dragRef.current;
		if (!start || !size) return;
		const dx = (event.clientX - start.x) / scale;
		const dy = (event.clientY - start.y) / scale;
		if (start.kind === "move") setRect(moveCrop(start.rect, dx, dy, size));
		else {
			const bounds = imageRef.current.getBoundingClientRect();
			const point = { x: (event.clientX - bounds.left) / scale, y: (event.clientY - bounds.top) / scale };
			setRect(dragCropCorner(start.rect, start.kind, point, size, ratio));
		}
	}

	function endDrag() {
		dragRef.current = null;
	}

	function pressKey(event) {
		const step = event.shiftKey ? KEY_STEP * 5 : KEY_STEP;
		const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
		const move = moves[event.key];
		if (!move || !rect || !size) return;
		event.preventDefault();
		setRect(moveCrop(rect, move[0], move[1], size));
	}

	async function apply() {
		setIsSaving(true);
		try {
			const file = await cropToFile(source, rect);
			const url = await uploadImage(file.file);
			onCropped({ url, width: file.width, height: file.height });
			onOpenChange(false);
		} catch (failure) {
			setError(failure.message);
		} finally {
			setIsSaving(false);
		}
	}

	const isWhole = rect && size && rect.width >= size.width - 1 && rect.height >= size.height - 1;
	const isReady = Boolean(source && rect);

	return (
		<Dialog open onOpenChange={(isOpen) => !isSaving && onOpenChange(isOpen)}>
			<DialogContent className="sm:max-w-xl">
				<DialogHeader>
					<DialogTitle>Crop picture</DialogTitle>
					<DialogDescription>Drag the box or its corners. The cropped picture is saved as a new one in your media library and replaces this one in the issue; the original stays there.</DialogDescription>
				</DialogHeader>
				{error && (
					<p role="alert" className="text-sm text-destructive">
						{error}
					</p>
				)}
				{!isReady && !error && <Loader2 className="mx-auto my-10 size-5 animate-spin text-muted-foreground" />}
				{isReady && (
					<>
						<div role="radiogroup" aria-label="Shape" className="flex flex-wrap gap-1.5">
							{CROP_RATIOS.map(({ id, label }) => (
								<button
									key={id}
									type="button"
									role="radio"
									aria-checked={ratioId === id}
									onClick={() => choose(id)}
									className={cn(
										"h-7 rounded-full px-3 text-xs font-medium outline-none transition-[background-color,box-shadow] duration-150 focus-visible:ring-2 focus-visible:ring-ring",
										ratioId === id ? "bg-foreground text-background" : "text-muted-foreground shadow-border hover:bg-muted/60 hover:text-foreground"
									)}
								>
									{label}
								</button>
							))}
						</div>
						<div className="flex justify-center rounded-lg bg-muted/40 p-2">
							<div className="relative inline-block touch-none select-none">
								{/* eslint-disable-next-line @next/next/no-img-element */}
								<img ref={imageRef} src={previewUrl} alt="" draggable={false} onLoad={measure} className="block max-h-[50dvh] max-w-full" />
								<div
									role="group"
									tabIndex={0}
									aria-label={`Crop box, ${Math.round(rect.width)} by ${Math.round(rect.height)} pixels. Arrow keys move it.`}
									onPointerDown={(event) => startDrag(event, "move")}
									onPointerMove={drag}
									onPointerUp={endDrag}
									onKeyDown={pressKey}
									className="absolute cursor-move border-2 border-white shadow-[0_0_0_9999px_rgba(0,0,0,0.5)] outline-none focus-visible:ring-2 focus-visible:ring-ring"
									style={{ left: rect.x * scale, top: rect.y * scale, width: rect.width * scale, height: rect.height * scale }}
								>
									{CORNERS.map(({ id, className, label }) => (
										<span
											key={id}
											role="presentation"
											title={label}
											onPointerDown={(event) => startDrag(event, id)}
											onPointerMove={drag}
											onPointerUp={endDrag}
											className={cn("absolute size-3.5 rounded-sm border border-black/40 bg-white", className)}
										/>
									))}
								</div>
							</div>
						</div>
						<p className="text-xs text-muted-foreground tabular-nums">
							{Math.round(rect.width)} × {Math.round(rect.height)} pixels{rect.width < MIN_CROP_SIDE || rect.height < MIN_CROP_SIDE ? ", very small" : ""}
						</p>
					</>
				)}
				<DialogFooter>
					<Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSaving}>
						Cancel
					</Button>
					<Button onClick={apply} disabled={!isReady || isSaving || isWhole} className="min-w-20">
						{isSaving ? <Loader2 className="animate-spin" /> : "Crop"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
