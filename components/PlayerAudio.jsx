"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Pause, Play, RotateCcw, RotateCw } from "lucide-react";
import { cn } from "@/lib/utils";

export const SPEEDS = [1, 1.25, 1.5, 2];
export const SKIP_SECONDS = 15;
// The position is kept in this browser only, once every few seconds: nothing about listening is sent anywhere.
const SAVE_EVERY_SECONDS = 4;

export function formatTime(value) {
	const total = Math.max(0, Math.floor(Number.isFinite(value) ? value : 0));
	const hours = Math.floor(total / 3600);
	const rest = `${String(Math.floor((total % 3600) / 60)).padStart(hours > 0 ? 2 : 1, "0")}:${String(total % 60).padStart(2, "0")}`;
	return hours > 0 ? `${hours}:${rest}` : rest;
}

function readStorage(key) {
	try {
		return window.localStorage.getItem(key);
	} catch {
		return null;
	}
}

function writeStorage(key, value) {
	try {
		if (value === null) window.localStorage.removeItem(key);
		else window.localStorage.setItem(key, String(value));
	} catch {
		// Private windows and blocked storage just don't remember.
	}
}

const subscribeToStorage = (notify) => {
	window.addEventListener("storage", notify);
	return () => window.removeEventListener("storage", notify);
};

// The audio version of an issue: play and pause, 15 seconds back and forward, four speeds, a slider, and where you stopped
// remembered in localStorage. A plain audio element underneath, so the browser streams it with range requests.
export default function PlayerAudio({ src, seconds, title, storageKey, className }) {
	const audioRef = useRef(null);
	const savedAt = useRef(0);
	const [isPlaying, setIsPlaying] = useState(false);
	const positionKey = `flockstack:audio:${storageKey}`;
	// What this browser remembers is read after hydration (the server renders 0 and 1x), and the player's own state takes
	// over from the first thing the listener does.
	const savedPosition = useSyncExternalStore(
		subscribeToStorage,
		() => {
			const saved = Number(readStorage(positionKey));
			return Number.isFinite(saved) && saved > 1 ? saved : 0;
		},
		() => 0
	);
	const savedRate = useSyncExternalStore(
		subscribeToStorage,
		() => {
			const saved = Number(readStorage("flockstack:audio-speed"));
			return SPEEDS.includes(saved) ? saved : 1;
		},
		() => 1
	);
	const [position, setCurrent] = useState(null);
	const [chosenRate, setRate] = useState(null);
	const current = position ?? savedPosition;
	const rate = chosenRate ?? savedRate;
	const [duration, setDuration] = useState(seconds || 0);
	const [hasError, setHasError] = useState(false);

	useEffect(() => {
		if (audioRef.current) audioRef.current.playbackRate = rate;
	}, [rate]);

	function toggle() {
		const audio = audioRef.current;
		if (!audio) return;
		if (audio.paused) {
			// The saved position is applied as playing starts: the file isn't fetched before.
			if (current > 1 && Math.abs(audio.currentTime - current) > 1) audio.currentTime = current;
			audio.play().catch(() => setHasError(true));
		} else {
			audio.pause();
		}
	}

	function seek(to) {
		const audio = audioRef.current;
		const limit = duration || audio?.duration || to;
		const next = Math.min(Math.max(0, to), limit);
		if (audio) audio.currentTime = next;
		setCurrent(next);
		writeStorage(positionKey, Math.floor(next));
	}

	function chooseSpeed(next) {
		setRate(next);
		writeStorage("flockstack:audio-speed", next);
	}

	function handleTime() {
		const audio = audioRef.current;
		setCurrent(audio.currentTime);
		if (Math.abs(audio.currentTime - savedAt.current) >= SAVE_EVERY_SECONDS) {
			savedAt.current = audio.currentTime;
			writeStorage(positionKey, Math.floor(audio.currentTime));
		}
	}

	const total = duration || seconds || 0;
	const label = `${formatTime(current)} of ${formatTime(total)}`;

	return (
		<section id="listen" aria-label="Listen to this issue" className={cn("scroll-mt-24 rounded-xl bg-card px-4 py-3 shadow-border", className)}>
			<audio
				ref={audioRef}
				src={src}
				preload="none"
				onPlay={() => setIsPlaying(true)}
				onPause={() => setIsPlaying(false)}
				onEnded={() => {
					setIsPlaying(false);
					setCurrent(0);
					writeStorage(positionKey, null);
				}}
				onTimeUpdate={handleTime}
				onLoadedMetadata={(event) => {
					if (Number.isFinite(event.currentTarget.duration)) setDuration(event.currentTarget.duration);
				}}
				onError={() => setHasError(true)}
			/>
			<div className="flex items-center gap-3">
				<button
					type="button"
					onClick={toggle}
					aria-label={isPlaying ? `Pause ${title}` : `Play ${title}`}
					className="grid size-10 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground transition-[scale,background-color] duration-150 outline-none hover:bg-primary/80 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background active:scale-[0.96]"
				>
					{isPlaying ? <Pause className="size-4" aria-hidden="true" /> : <Play className="size-4 translate-x-px" aria-hidden="true" />}
				</button>
				<div className="min-w-0 flex-1">
					<p className="truncate text-sm font-medium">Listen to this issue</p>
					<p className="text-xs text-muted-foreground tabular-nums">
						{formatTime(current)} / {formatTime(total)}
					</p>
				</div>
				<div className="flex items-center gap-1">
					<SkipButton label={`Back ${SKIP_SECONDS} seconds`} onClick={() => seek(current - SKIP_SECONDS)}>
						<RotateCcw className="size-4" aria-hidden="true" />
					</SkipButton>
					<SkipButton label={`Forward ${SKIP_SECONDS} seconds`} onClick={() => seek(current + SKIP_SECONDS)}>
						<RotateCw className="size-4" aria-hidden="true" />
					</SkipButton>
				</div>
			</div>
			<input
				type="range"
				min={0}
				max={Math.max(1, Math.floor(total))}
				step={1}
				value={Math.min(Math.floor(current), Math.max(1, Math.floor(total)))}
				onChange={(event) => seek(Number(event.target.value))}
				aria-label="Seek"
				aria-valuetext={label}
				className="mt-3 h-1.5 w-full cursor-pointer accent-[var(--site-accent,currentColor)]"
			/>
			<div role="group" aria-label="Playback speed" className="mt-2 flex items-center gap-1">
				{SPEEDS.map((speed) => (
					<button
						key={speed}
						type="button"
						aria-pressed={rate === speed}
						onClick={() => chooseSpeed(speed)}
						className={cn(
							"h-7 rounded-md px-2 text-xs font-medium tabular-nums transition-colors duration-150 outline-none focus-visible:ring-2 focus-visible:ring-ring",
							rate === speed ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
						)}
					>
						{speed}x
					</button>
				))}
			</div>
			<p role="status" aria-live="polite" className={cn("mt-2 text-xs text-destructive", !hasError && "sr-only")}>
				{hasError ? "The audio can't be played right now. Try again in a moment." : ""}
			</p>
		</section>
	);
}

function SkipButton({ label, onClick, children }) {
	return (
		<button
			type="button"
			onClick={onClick}
			aria-label={label}
			title={label}
			className="grid size-9 place-items-center rounded-lg text-muted-foreground transition-colors duration-150 outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
		>
			{children}
		</button>
	);
}
