"use client";
import { useState, useTransition } from "react";
import { prepareSponsorBlock } from "@/app/(app)/sponsorships/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
export default function PanelSponsorInsert({ editor, campaignId }) {
	const [bookingId, setBookingId] = useState(""), [error, setError] = useState(null), [pending, start] = useTransition();
	if (!campaignId) return null;
	function insert() {
		setError(null);
		start(async () => {
			const result = await prepareSponsorBlock({ id: bookingId.trim(), campaignId });
			if (result.error) { setError(result.error); return; }
			if (!editor || editor.isDestroyed) { setError("The editor closed. Reopen it to insert this booking, or detach it from the sponsor page."); return; }
			editor.chain().focus().insertContent(result.html).run(); setBookingId("");
		});
	}
	return <details className="mb-4 rounded-md border p-3 text-sm"><summary className="cursor-pointer">Insert sponsor</summary><div className="mt-3 flex flex-col gap-3"><p className="text-muted-foreground">Copy a paid and owner-approved booking ID from <a href="/sponsorships" target="_blank" rel="noreferrer" className="underline">Sponsorships</a>. The block is inserted at your current cursor and saved with the draft.</p><label>Booking ID<Input value={bookingId} onChange={event => setBookingId(event.target.value)} maxLength={24} /></label><Button type="button" variant="outline" disabled={pending || !/^[a-f0-9]{24}$/.test(bookingId.trim())} onClick={insert} className="self-start">{pending ? "Preparing…" : "Insert approved placement"}</Button>{error && <p role="alert" className="text-destructive">{error}</p>}</div></details>;
}
