"use client";

import { useState, useTransition } from "react";
import Image from "next/image";
import { generateMediaImage } from "@/app/(app)/media/actions";
import { Button } from "@/components/ui/button";
import { DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { forgetImageLibrary } from "@/lib/upload-image";

export default function PickerGeneratedImage({ newsletterId, onSelect }) {
	const [prompt, setPrompt] = useState("");
	const [consent, setConsent] = useState(false);
	const [alt, setAlt] = useState("");
	const [image, setImage] = useState(null);
	const [error, setError] = useState("");
	const [pending, start] = useTransition();
	function generate(event) {
		event.preventDefault();
		start(async () => {
			setError("");
			try {
				const result = await generateMediaImage(newsletterId, prompt, consent);
				if (result.error) setError(result.error);
				else { forgetImageLibrary(); setImage(result.image); setAlt(""); }
			} catch { setError("Couldn't generate the image. Check your media library before retrying; the attempt may have been counted."); }
		});
	}
	return <div className="space-y-4 p-4">
		<DialogHeader><DialogTitle>Generate an image</DialogTitle><DialogDescription>Describe one image, then review it before inserting.</DialogDescription></DialogHeader>
		<form onSubmit={generate} className="space-y-3">
			<label className="block space-y-2 text-sm">Image description<Textarea required maxLength={2048} value={prompt} onChange={(event) => setPrompt(event.target.value)} disabled={pending} /></label>
			<label className="flex items-start gap-2 text-sm"><input type="checkbox" required checked={consent} onChange={(event) => setConsent(event.target.checked)} disabled={pending} className="mt-1" /><span>Send this description to Cloudflare Workers AI, which may process it outside my region, and save the image at a public URL. Don’t include private information.</span></label>
			<p className="text-xs text-muted-foreground">One shared daily AI request per attempt once generation starts, including failures. FlockStack keeps the image, model and date, never your description. Review the result and your rights before use.</p>
			<Button type="submit" disabled={pending || !consent || !prompt.trim()}>{pending ? "Generating…" : "Generate image"}</Button>
		</form>
		{error && <p role="alert" className="text-sm text-destructive">{error}</p>}
		{image && <div className="space-y-3 border-t pt-4">
			<Image src={image.url} alt="Generated preview" width={image.width} height={image.height} unoptimized className="max-h-64 w-full object-contain" />
			<p className="text-xs text-muted-foreground">AI generated · FLUX.1 schnell · saved in your media library. {image.usage.used} AI requests used today{image.usage.limit === null ? "." : ` of ${image.usage.limit}.`}</p>
			<label className="block space-y-2 text-sm">Alt text<Input value={alt} onChange={(event) => setAlt(event.target.value)} maxLength={500} placeholder="Describe what readers should know" /></label>
			<Button type="button" disabled={pending} onClick={() => onSelect({ ...image, alt })}>Insert image</Button>
		</div>}
	</div>;
}
