"use client";
import { getReaderText } from "@/lib/reader-languages";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export default function FormSponsorshipUpload({ bookingId, token = null, language = "en" }) {
	const t = getReaderText(language);
	const router = useRouter();
	const [pending, setPending] = useState(false), [state, setState] = useState(null), [retry, setRetry] = useState(null);
	async function upload(event) {
		event.preventDefault(); if (pending) return;
		const form = new FormData(event.currentTarget), file = form.get("file");
		if (!file?.size || file.size > 5 * 1024 * 1024) { setState({ error: "Choose a PNG, JPEG or WebP up to 5 MiB" }); return; }
		const attempt = retry?.file.name === file.name && retry.file.size === file.size && retry.file.lastModified === file.lastModified ? retry : { file, id: crypto.randomUUID() }; setRetry(attempt);
		setPending(true); setState(null);
		try {
			const response = await fetch("/api/sponsorship-assets", { method: "POST", body: file, credentials: token ? "omit" : "same-origin", headers: { "content-type": "application/octet-stream", "x-booking-id": bookingId, "x-file-name": encodeURIComponent(file.name), "x-external-id": attempt.id, "x-publication-consent": form.get("consent") === "on" ? "true" : "false", ...(token && { "x-sponsor-token": token }) } });
			const result = await response.json(); if (!response.ok) throw new Error(result.error ?? "Upload failed");
			setState({ message: "Private image uploaded. Select it in the creative below, then save for review." }); setRetry(null); router.refresh();
		} catch (error) { setState({ error: error.message ?? "Upload failed. Retry this same file." }); }
		finally { setPending(false); }
	}
	return <form onSubmit={upload} className="space-y-3"><label className="block text-sm">{t("Sponsor image")}<Input type="file" name="file" accept="image/png,image/jpeg,image/webp" required onChange={() => setRetry(null)} /></label><p className="text-sm text-muted-foreground">{t("Up to 5 MiB, 8192 pixels per side and 32 megapixels. Five uploads per booking. Files stay private until approval.")}</p><label className="flex items-start gap-2 text-sm"><input type="checkbox" name="consent" required className="mt-1" />{t("I have permission to use this image and agree that it becomes publicly accessible when the owner approves the selected creative. Public images remain available to sent issues until account deletion.")}</label><Button type="submit" variant="outline" disabled={pending}>{pending ? t("Uploading…") : t("Upload private image")}</Button>{state?.error && <p role="alert" className="text-sm text-destructive">{t.error(state.error)}</p>}{state?.message && <p role="status" className="text-sm">{t(state.message)}</p>}</form>;
}
