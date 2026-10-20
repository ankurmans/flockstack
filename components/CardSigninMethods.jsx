"use client";

import { useActionState, useState } from "react";
import { Loader2 } from "lucide-react";
import { connectSignin, unlinkSignin } from "@/app/(account)/account/actions";
import { IconApple } from "@/components/ButtonSigninApple";
import { IconGoogle } from "@/components/ButtonSigninGoogle";
import CardSettings, { RowSettings } from "@/components/CardSettings";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { formatDate } from "@/lib/format";
import { submitKeepingFields } from "@/lib/submit-keeping-fields";
import { toast } from "@/lib/toast";

const ICONS = { google: IconGoogle, apple: IconApple };

// The Google and Apple accounts that sign this user in, each with Unlink, and Connect for a provider this server has that
// isn't linked. methods: [{ provider, name, account: { id, linkedAt } | null }]. notice: what came back from connecting.
export default function CardSigninMethods({ methods, email, notice }) {
	return (
		<CardSettings title="Sign-in methods" stagger={1}>
			{methods.map((method) => (
				<RowSettings key={method.provider} label={method.name}>
					{method.account ? <RowLinked method={method} email={email} /> : <FormConnect method={method} />}
				</RowSettings>
			))}
			<p className="px-4 py-3 text-sm text-pretty text-muted-foreground">
				A code sent to <span className="font-medium text-foreground">{email}</span> always signs you in too, whatever you connect or unlink
				here.
			</p>
			{notice && (
				<p role={notice.isError ? "alert" : "status"} className={notice.isError ? "px-4 py-3 text-sm text-pretty text-destructive" : "px-4 py-3 text-sm text-pretty"}>
					{notice.text}
				</p>
			)}
		</CardSettings>
	);
}

function FormConnect({ method }) {
	const Icon = ICONS[method.provider];
	return (
		<form action={connectSignin} className="flex min-h-9 items-center justify-between gap-3">
			<input type="hidden" name="provider" value={method.provider} />
			<span className="text-sm text-muted-foreground">Not connected</span>
			<Button type="submit" variant="outline" size="sm">
				<Icon />
				Connect {method.name}
			</Button>
		</form>
	);
}

function RowLinked({ method, email }) {
	const [isOpen, setIsOpen] = useState(false);
	const [state, action, isPending] = useActionState(async (previous, formData) => {
		const result = await unlinkSignin(previous, formData);
		if (result?.error) return result;
		setIsOpen(false);
		toast.success(`${result.name} unlinked. Sign in with a code sent to ${email}.`);
		return result;
	}, null);
	const Icon = ICONS[method.provider];

	return (
		<span className="flex min-h-9 items-center justify-between gap-3">
			<span className="flex min-w-0 items-center gap-2 text-sm [&_svg]:size-4 [&_svg]:shrink-0">
				<Icon />
				<span className="truncate">Connected{method.account.linkedAt && <span className="text-muted-foreground"> · since {formatDate(method.account.linkedAt)}</span>}</span>
			</span>
			<Button type="button" variant="outline" size="sm" onClick={() => setIsOpen(true)}>
				Unlink
			</Button>
			<Dialog open={isOpen} onOpenChange={setIsOpen}>
				<DialogContent className="sm:max-w-sm">
					<form action={action} onSubmit={submitKeepingFields(action)} className="flex flex-col gap-4">
						<input type="hidden" name="id" value={method.account.id} />
						<DialogHeader>
							<DialogTitle>Unlink {method.name}?</DialogTitle>
							<DialogDescription>
								You won&apos;t sign in with {method.name} any more. A code sent to <span className="font-medium text-foreground">{email}</span> still
								signs you in, and you can connect {method.name} again here.
							</DialogDescription>
						</DialogHeader>
						{state?.error && (
							<p role="alert" className="text-sm text-pretty text-destructive">
								{state.error}
							</p>
						)}
						<DialogFooter>
							<DialogClose asChild>
								<Button type="button" variant="outline">
									Cancel
								</Button>
							</DialogClose>
							<Button type="submit" variant="destructive" disabled={isPending} className="min-w-20">
								{isPending ? <Loader2 className="animate-spin" /> : "Unlink"}
							</Button>
						</DialogFooter>
					</form>
				</DialogContent>
			</Dialog>
		</span>
	);
}
