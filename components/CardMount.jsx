"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { CircleCheck, CircleDashed, Loader2 } from "lucide-react";
import { checkMount, removeMount, rotateMountToken, setMount } from "@/app/(app)/newsletters/actions";
import ButtonCopy from "@/components/ButtonCopy";
import CardSettings, { RowSettings } from "@/components/CardSettings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

// The website at a path of a site the owner runs (lib/mounts.js): the address, the token shown once, where the proxy forwards,
// and the check that moves the pages there. Beside the website's address in the newsletter's settings.
export default function CardMount({ newsletterId, initial, archiveHost, upstream, stagger = 0, className }) {
	const [mount, setMountState] = useState(initial);
	const [url, setUrl] = useState(initial?.url ?? "");
	const [token, setToken] = useState(null);
	const [problem, setProblem] = useState(null);
	const [isPending, startTransition] = useTransition();

	function save(event) {
		event.preventDefault();
		startTransition(async () => {
			const result = await setMount(newsletterId, url);
			if (result.error) return void toast.error(result.error);
			setMountState(result.mount);
			setToken(result.token);
			setProblem(null);
		});
	}

	function check() {
		startTransition(async () => {
			const result = await checkMount(newsletterId);
			if (result.error) return void toast.error(result.error);
			setMountState(result.mount);
			setProblem(result.problem);
			if (result.verified) toast.success("Your site forwards to FlockStack");
		});
	}

	function rotate() {
		startTransition(async () => {
			const result = await rotateMountToken(newsletterId);
			if (result.error) return void toast.error(result.error);
			setMountState(result.mount);
			setToken(result.token);
		});
	}

	function remove() {
		startTransition(async () => {
			const result = await removeMount(newsletterId);
			if (result.error) return void toast.error(result.error);
			setMountState(null);
			setToken(null);
			setProblem(null);
		});
	}

	return (
		<CardSettings id="subfolder" title="Subfolder on your site" stagger={stagger} className={cn("scroll-mt-20", className)}>
			<p className="px-4 py-3 text-sm text-pretty text-muted-foreground">
				Serve the website at a path of a site you run, like https://example.com/newsletter. Your site&apos;s proxy forwards that path to
				FlockStack with a token. Links in emails stay on FlockStack.{" "}
				<Link href="/docs/subfolder" className="font-medium text-foreground underline decoration-foreground/30 underline-offset-4 hover:decoration-foreground">
					Proxy recipes
				</Link>
			</p>
			{archiveHost ? (
				<p className="px-4 py-3 text-sm text-pretty text-muted-foreground">
					This website is on {archiveHost}. A newsletter has its own subdomain or a subfolder, not both.
				</p>
			) : (
				<>
					<form onSubmit={save} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center">
						<Input aria-label="Address on your site" placeholder="https://example.com/newsletter" value={url} onChange={(event) => setUrl(event.target.value)} required />
						<Button type="submit" size="sm" variant="outline" disabled={isPending} className="shrink-0">
							{isPending && <Loader2 className="animate-spin" data-icon="inline-start" />}
							{mount ? "Save and get a new token" : "Set up"}
						</Button>
					</form>
					{token && (
						<RowSettings label="Token" hint="Shown once. Put it in your proxy's X-FlockStack-Mount header, kept as a secret, not in a file you commit.">
							<span className="flex min-w-0 items-center gap-1.5">
								<code className="truncate font-mono text-[13px]">{token}</code>
								<ButtonCopy value={token} label="Copy token" />
							</span>
						</RowSettings>
					)}
					{mount && (
						<>
							<RowSettings label="Forward to" hint={`Strip ${mount.path} and forward the rest here, with X-FlockStack-Mount and X-Forwarded-Host.`}>
								<span className="flex min-w-0 items-center gap-1.5">
									<code className="truncate font-mono text-[13px]">{mount.upstream ?? upstream}</code>
									<ButtonCopy value={mount.upstream ?? upstream} label="Copy address" />
								</span>
							</RowSettings>
							<RowSettings label="Status" hint={problem ?? (mount.previousTokenUntil ? `The previous token works until ${new Date(mount.previousTokenUntil).toLocaleString()}.` : null)}>
								<span className="flex items-center gap-1.5 text-sm sm:min-h-9">
									{mount.verified ? <CircleCheck className="size-4 shrink-0 text-emerald-500" aria-hidden="true" /> : <CircleDashed className="size-4 text-muted-foreground" aria-hidden="true" />}
									{mount.verified ? `Live at ${mount.url}` : "Waiting for a check"}
								</span>
							</RowSettings>
							<div className="flex flex-wrap gap-2 px-4 py-3">
								<Button type="button" size="sm" variant="outline" disabled={isPending} onClick={check}>
									Check
								</Button>
								<Button type="button" size="sm" variant="outline" disabled={isPending} onClick={rotate}>
									New token
								</Button>
								<Button type="button" size="sm" variant="ghost" disabled={isPending} onClick={remove}>
									Remove
								</Button>
							</div>
						</>
					)}
				</>
			)}
		</CardSettings>
	);
}
