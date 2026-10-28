"use client";

import { useState, useTransition } from "react";
import { Loader2 } from "lucide-react";
import { addAiKey } from "@/app/(app)/ai-keys/actions";
import CardSettings, { RowSettings } from "@/components/CardSettings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/lib/toast";

const SELECT = "h-9 rounded-lg border border-input bg-transparent px-2.5 text-sm";
const EMPTY = { name: "", provider: "openrouter", key: "", baseUrl: "", accountRef: "" };

// Adds an AI key. The key field is a password field, cleared once it is saved, and the answer carries only its last four characters.
export default function FormAiKey({ providers }) {
	const [draft, setDraft] = useState(EMPTY);
	const [isPending, startTransition] = useTransition();
	const set = (key, value) => setDraft((current) => ({ ...current, [key]: value }));

	function save(event) {
		event.preventDefault();
		startTransition(async () => {
			const result = await addAiKey(draft);
			if (result?.error) return void toast.error(result.error);
			setDraft(EMPTY);
			toast.success(`Key …${result.hint} saved`);
		});
	}

	return (
		<form onSubmit={save} autoComplete="off">
			<CardSettings title="Add a key">
				<RowSettings label="Provider" isLabel>
					<select value={draft.provider} onChange={(event) => set("provider", event.target.value)} className={SELECT}>
						{providers.map(({ value, label }) => (
							<option key={value} value={value}>
								{label}
							</option>
						))}
					</select>
				</RowSettings>
				{draft.provider === "openai-compatible" && (
					<RowSettings label="Address" hint="The server's https address, on a public host" isLabel>
						<Input value={draft.baseUrl} onChange={(event) => set("baseUrl", event.target.value)} placeholder="https://llm.example.com/v1" maxLength={500} inputMode="url" required />
					</RowSettings>
				)}
				{draft.provider === "cloudflare" && (
					<RowSettings label="Account ID" hint="Your Cloudflare account ID, on the Workers AI page" isLabel>
						<Input value={draft.accountRef} onChange={(event) => set("accountRef", event.target.value)} maxLength={64} required />
					</RowSettings>
				)}
				<RowSettings label="Name" isLabel>
					<Input value={draft.name} onChange={(event) => set("name", event.target.value)} placeholder="Briefings key" maxLength={60} required />
				</RowSettings>
				<RowSettings label="Key" hint="Encrypted when saved, and never shown again" isLabel>
					<Input type="password" value={draft.key} onChange={(event) => set("key", event.target.value)} autoComplete="new-password" spellCheck={false} maxLength={600} required />
				</RowSettings>
				<div className="px-4 py-3">
					<Button type="submit" disabled={isPending}>
						{isPending && <Loader2 className="animate-spin" />}
						Save the key
					</Button>
				</div>
			</CardSettings>
		</form>
	);
}
