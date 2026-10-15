"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { Monitor, Smartphone, X } from "lucide-react";
import AvatarNewsletter from "@/components/AvatarNewsletter";
import { Dialog, DialogOverlay, DialogPortal, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

// The email over the whole dashboard, centered on a dimmed backdrop at the width inboxes give it. Escape, the close
// button and a click on the dimmed space close it; Radix keeps the focus inside meanwhile.
export default function DialogPreviewEmail({ isOpen, onOpenChange, onCloseAutoFocus, ...email }) {
	return (
		<Dialog open={isOpen} onOpenChange={onOpenChange}>
			<DialogPortal>
				<DialogOverlay className="bg-black/70" />
				<DialogPrimitive.Content
					aria-describedby={undefined}
					onCloseAutoFocus={onCloseAutoFocus}
					className="fixed inset-0 z-50 outline-none duration-200 data-open:animate-in data-open:fade-in-0 data-open:slide-in-from-bottom-2 data-closed:animate-out data-closed:fade-out-0"
				>
					<DialogTitle className="sr-only">Preview</DialogTitle>
					<Stage {...email} onClose={() => onOpenChange(false)} />
				</DialogPrimitive.Content>
			</DialogPortal>
		</Dialog>
	);
}

// Narrower than the email (a phone showing the desktop width), the email scales down whole instead of reflowing.
function Stage({ html, sender, subject, previewText, onClose }) {
	const [device, setDevice] = useState(() => (window.matchMedia(SMALL_SCREEN).matches ? "mobile" : "desktop"));
	const [space, setSpace] = useState(null);
	const spaceRef = useRef(null);
	const isPressOnDim = useRef(false);
	const width = DEVICES.find(({ id }) => id === device).width;
	const scale = space ? Math.min(1, space.width / width) : 1;

	useLayoutEffect(() => {
		const observer = new ResizeObserver(([entry]) => setSpace({ width: entry.contentRect.width, height: entry.contentRect.height }));
		observer.observe(spaceRef.current);
		return () => observer.disconnect();
	}, []);

	return (
		<div
			data-dim
			onPointerDown={(event) => (isPressOnDim.current = isDim(event.target))}
			onClick={(event) => isPressOnDim.current && isDim(event.target) && onClose()}
			className="flex h-full flex-col"
		>
			<div data-dim className="relative flex h-16 shrink-0 items-center justify-center px-16">
				<div role="radiogroup" aria-label="Device" className="flex items-center gap-1 rounded-full bg-white/10 p-1">
					{DEVICES.map(({ id, label, icon: Icon }) => (
						<button
							key={id}
							type="button"
							role="radio"
							aria-checked={device === id}
							onClick={() => setDevice(id)}
							className={cn(
								"flex h-8 items-center gap-1.5 rounded-full px-3.5 text-sm font-medium outline-none transition-[color,background-color,scale] duration-150 ease-out focus-visible:ring-3 focus-visible:ring-white/40 active:scale-[0.97]",
								device === id ? "bg-white text-zinc-900" : "text-white/70 hover:text-white"
							)}
						>
							<Icon className="size-4" aria-hidden="true" />
							{label}
						</button>
					))}
				</div>
				<button
					type="button"
					onClick={onClose}
					aria-label="Close preview"
					className="absolute top-1/2 right-3 grid size-9 -translate-y-1/2 place-items-center rounded-full bg-white/10 text-white outline-none transition-[background-color,scale] duration-150 ease-out hover:bg-white/20 focus-visible:ring-3 focus-visible:ring-white/40 active:scale-[0.96] sm:right-5"
				>
					<X className="size-4" />
				</button>
			</div>
			<div data-dim className="min-h-0 flex-1 px-3 sm:px-6 sm:pb-6">
				<div ref={spaceRef} data-dim className="relative h-full">
					<div
						style={{
							width,
							height: space ? space.height / scale : "100%",
							transform: `translateX(-50%) scale(${scale})`,
						}}
						className="absolute top-0 left-1/2 flex origin-top flex-col overflow-hidden rounded-t-xl bg-white text-zinc-900 shadow-2xl transition-[width,transform] duration-300 ease-[cubic-bezier(0.2,0,0,1)] sm:rounded-xl"
					>
						<div className="flex shrink-0 items-center gap-3 border-b border-zinc-200 px-4 py-3 text-sm">
							<AvatarNewsletter newsletter={sender} size={40} className="rounded-full bg-zinc-100 text-zinc-500" />
							<div className="min-w-0 flex-1">
								<p className="truncate">
									<span className="font-semibold">{sender.fromName || sender.name}</span>{" "}
									<span className="text-zinc-500">&lt;{sender.fromEmail}&gt;</span>
								</p>
								<p className="truncate">
									<span className="font-medium">{subject || "No subject"}</span>
									{previewText && <span className="text-zinc-500"> — {previewText}</span>}
								</p>
							</div>
						</div>
						{/* Without allow-scripts nothing in the email runs. */}
						<iframe title="Email preview" sandbox="" srcDoc={html} className="min-h-0 w-full flex-1 bg-white" />
					</div>
				</div>
			</div>
		</div>
	);
}

function isDim(target) {
	return target instanceof Element && target.hasAttribute("data-dim");
}

const SMALL_SCREEN = "(max-width: 639px)";
const DEVICES = [
	{ id: "desktop", label: "Desktop", icon: Monitor, width: 640 },
	{ id: "mobile", label: "Mobile", icon: Smartphone, width: 375 },
];
