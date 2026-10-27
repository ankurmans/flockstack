"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { saveShortPost, scheduleCampaign, startSend, unscheduleCampaign } from "@/app/(app)/campaigns/actions";
import HeaderPage from "@/components/HeaderPage";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

export default function FormShortPost({ campaign, body: initialBody, archiveUrl }) {
	const router = useRouter();
	const [body, setBody] = useState(initialBody);
	const [date, setDate] = useState("");
	const [error, setError] = useState("");
	const [saved, setSaved] = useState(false);
	const [pending, startTransition] = useTransition();
	const published = campaign.status === "sent";
	const editable = ["draft", "scheduled", "sent"].includes(campaign.status);
	function run(intent) {
		startTransition(async () => {
			setError(""); setSaved(false);
			if (intent !== "unschedule") {
				const result = await saveShortPost(campaign.id, body, published);
				if (result.error) return void setError(result.error);
			}
			let result;
			if (intent === "publish") result = await startSend(campaign.id);
			if (intent === "schedule") {
				const at = new Date(`${date}Z`);
				if (!Number.isFinite(at.getTime())) return void setError("Choose a date and time in UTC");
				result = await scheduleCampaign(campaign.id, { scheduledAt: at.toISOString() });
			}
			if (intent === "unschedule") result = await unscheduleCampaign(campaign.id);
			if (result?.error) return void setError(result.error);
			setSaved(true); router.refresh();
		});
	}
	return <><HeaderPage title="Short web post" /><div className="mx-auto flex w-full max-w-2xl flex-col gap-5">
		<Link href="/campaigns" className="text-sm underline">Campaigns</Link>
		<p className="text-sm text-muted-foreground">A public post with no title and no email. It appears on your website and in RSS. Keep it to 2,000 text characters. A weekly digest can be drafted from the New menu, then reviewed and scheduled as a normal email.</p>
		<p className="text-xs text-muted-foreground">Status: {published ? "Published on the web" : campaign.status === "scheduled" ? "Scheduled for the web" : campaign.status}{campaign.scheduledAt ? ` · ${campaign.scheduledAt} (UTC)` : ""}{published ? ` · ${campaign.webViews} page views` : ""}</p>
		{archiveUrl && published && <a href={archiveUrl} target="_blank" rel="noreferrer" className="text-sm underline">View on the web</a>}
		{editable && <form className="flex flex-col gap-4" onSubmit={(event) => { event.preventDefault(); run("save"); }}>
			<label className="flex flex-col gap-2 text-sm">Post<Textarea name="body" className="min-h-64" value={body} maxLength={20000} disabled={pending} onChange={(event) => { setBody(event.target.value); setSaved(false); }} /></label>
			<p className="text-xs text-muted-foreground">Markdown is supported. Paid blocks, audience targeting and live RSS blocks belong in a newsletter issue. Publishing and scheduling use the same account and approval checks as other campaigns.</p>
			<div className="flex flex-wrap gap-2"><Button type="submit" disabled={pending}>{published ? "Save web changes" : "Save draft"}</Button>
				{!published && <Button type="button" variant="outline" disabled={pending || !body.trim()} onClick={() => run("publish")}>Publish now</Button>}
				{campaign.status === "scheduled" && <Button type="button" variant="outline" disabled={pending} onClick={() => run("unschedule")}>Take off schedule</Button>}
			</div>
			{!published && <div className="flex flex-wrap items-end gap-3"><label className="flex flex-col gap-2 text-sm">Publish later, in UTC<Input type="datetime-local" value={date} onChange={(event) => setDate(event.target.value)} disabled={pending} /></label><Button type="button" variant="outline" disabled={pending || !date || !body.trim()} onClick={() => run("schedule")}>Schedule web post</Button></div>}
			{error && <p role="alert" className="text-sm text-destructive">{error}</p>}{saved && <p role="status" className="text-sm">Saved.</p>}
		</form>}
	</div></>;
}
