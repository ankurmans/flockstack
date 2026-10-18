"use client";

import { useState } from "react";
import { KeyRound, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";

// Signs in with a passkey registered from the account page. next: where to go afterwards.
export default function ButtonSigninPasskey({ next }) {
	const [isPending, setIsPending] = useState(false);
	const [error, setError] = useState(null);

	async function signIn() {
		setIsPending(true);
		setError(null);
		const { error: failure } = await authClient.signIn.passkey();
		if (failure) {
			setIsPending(false);
			setError(failure.code === "AUTH_CANCELLED" ? null : "No passkey worked. Sign in with a code, then add one on the account page.");
			return;
		}
		window.location.assign(next || "/");
	}

	return (
		<div className="flex flex-col gap-2">
			<Button type="button" variant="outline" size="lg" onClick={signIn} disabled={isPending} className="h-11 w-full">
				{isPending ? <Loader2 className="animate-spin" /> : <KeyRound />}
				Sign in with a passkey
			</Button>
			{error && (
				<p role="alert" className="text-sm text-pretty text-destructive">
					{error}
				</p>
			)}
		</div>
	);
}
