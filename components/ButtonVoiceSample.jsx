"use client";

import { useEffect, useRef, useState } from "react";
import { Pause, Play } from "lucide-react";
import { Button } from "@/components/ui/button";

// Plays a recording of a voice, the sample its owner chose: nothing is made for it, so it costs nothing. One plays at a time.
let current = null;

export default function ButtonVoiceSample({ previewUrl, name }) {
	const audioRef = useRef(null);
	const [isPlaying, setIsPlaying] = useState(false);

	useEffect(() => {
		const audio = audioRef.current;
		return () => {
			audio?.pause();
			if (current === audio) current = null;
		};
	}, []);

	if (!previewUrl) return null;

	function toggle() {
		const audio = audioRef.current;
		if (!audio.paused) return void audio.pause();
		if (current && current !== audio) current.pause();
		current = audio;
		audio.play().catch(() => setIsPlaying(false));
	}

	return (
		<>
			<audio ref={audioRef} src={previewUrl} preload="none" onPlay={() => setIsPlaying(true)} onPause={() => setIsPlaying(false)} onEnded={() => setIsPlaying(false)} />
			<Button type="button" variant="ghost" size="sm" onClick={toggle} aria-label={`${isPlaying ? "Stop the sample of" : "Listen to a sample of"} ${name}`} className="text-muted-foreground">
				{isPlaying ? <Pause data-icon="inline-start" /> : <Play data-icon="inline-start" />}
				{isPlaying ? "Stop" : "Listen to a sample"}
			</Button>
		</>
	);
}
