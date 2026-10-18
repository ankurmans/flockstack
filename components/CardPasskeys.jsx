"use client";

import { useCallback, useEffect, useState } from "react";
import { KeyRound, Loader2, Trash2 } from "lucide-react";
import CardSettings, { RowSettings } from "@/components/CardSettings";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";
import { formatDate } from "@/lib/format";

// The passkeys that sign this user in without a code: listed, added from this device, and removed.
export default function CardPasskeys() {
	const [passkeys, setPasskeys] = useState(null);
	const [isBusy, setIsBusy] = useState(false);
	const [error, setError] = useState(null);

	const load = useCallback(async () => {
		const { data, error: failure } = await authClient.passkey.listUserPasskeys();
		if (failure) setError("Couldn't load your passkeys.");
		else setPasskeys(data ?? []);
	}, []);

	useEffect(() => {
		load();
	}, [load]);

	async function add() {
		setIsBusy(true);
		setError(null);
		const { error: failure } = await authClient.passkey.addPasskey({ name: `Passkey ${(passkeys?.length ?? 0) + 1}` });
		if (failure && failure.code !== "AUTH_CANCELLED") setError("Couldn't add a passkey on this device.");
		setIsBusy(false);
		await load();
	}

	async function remove(id) {
		setIsBusy(true);
		setError(null);
		const { error: failure } = await authClient.passkey.deletePasskey({ id });
		if (failure) setError("Couldn't remove that passkey.");
		setIsBusy(false);
		await load();
	}

	return (
		<CardSettings
			title="Passkeys"
			stagger={2}
			action={
				<Button type="button" variant="outline" size="sm" onClick={add} disabled={isBusy}>
					{isBusy ? <Loader2 className="animate-spin" /> : <KeyRound />}
					Add a passkey
				</Button>
			}
		>
			<RowSettings label="Sign in" hint="A passkey signs you in with your fingerprint, face or device PIN, with no code to wait for.">
				<span className="flex flex-col gap-2">
					{passkeys === null && <span className="text-sm text-muted-foreground">Loading…</span>}
					{passkeys?.length === 0 && <span className="text-sm text-muted-foreground">No passkeys yet.</span>}
					{passkeys?.map((passkey) => (
						<span key={passkey.id} className="flex h-9 items-center justify-between gap-3 rounded-lg bg-muted/60 px-2.5 text-sm">
							<span className="truncate">
								{passkey.name || "Passkey"}
								{passkey.createdAt && <span className="text-muted-foreground"> · added {formatDate(passkey.createdAt)}</span>}
							</span>
							<button
								type="button"
								onClick={() => remove(passkey.id)}
								disabled={isBusy}
								aria-label={`Remove ${passkey.name || "passkey"}`}
								className="text-muted-foreground transition-colors duration-150 hover:text-destructive disabled:opacity-50"
							>
								<Trash2 className="size-3.5" />
							</button>
						</span>
					))}
					{error && (
						<span role="alert" className="text-sm text-pretty text-destructive">
							{error}
						</span>
					)}
				</span>
			</RowSettings>
		</CardSettings>
	);
}
