"use client";

import { useState, useTransition } from "react";
import { Download, Loader2, Plus } from "lucide-react";
import { addIpAction, convertManagedPoolsAction, importIpsAction, retireIpAction } from "@/app/admin/actions";
import BadgeStatus from "@/components/BadgeStatus";
import CardStat from "@/components/CardStat";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDate, formatNumber, formatUsd } from "@/lib/format";
import { toast } from "@/lib/toast";

// The dedicated IPs AWS leased (lib/ip-inventory.js): what is free, what is in use and what idle ones cost. AWS has no API to
// lease one, so the IPs are leased in the AWS console and added here, or imported from AWS in one click.
export default function CardIpInventory({ inventory, managedPools, awsMonthlyCost }) {
	const { ips, counts, idleMonthlyCost, monthlyCost, waiting, purchases } = inventory;
	const [ip, setIp] = useState("");
	const [notes, setNotes] = useState("");
	const [isPending, startTransition] = useTransition();
	const inUse = counts.warming + counts.assigned;
	const isShort = counts.available < 1 && (waiting > 0 || purchases > 0);

	function run(task, success) {
		startTransition(async () => {
			const result = await task();
			if (result?.error) return void toast.error(result.error);
			toast.success(success(result));
		});
	}

	function add(event) {
		event.preventDefault();
		run(
			() => addIpAction(ip, notes),
			(result) => {
				setIp("");
				setNotes("");
				return result.assigned > 0 ? `${result.ip} added, and an account that was waiting got an IP` : `${result.ip} added`;
			}
		);
	}

	return (
		<div className="flex flex-col gap-4">
			<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
				<CardStat label="Free IPs" value={formatNumber(counts.available)} detail={isShort ? "None free: add one" : "Ready to give out"} tone={isShort ? "bad" : "default"} />
				<CardStat label="In use" value={formatNumber(inUse)} detail={`${formatNumber(counts.warming)} warming up`} />
				<CardStat label="Waiting for an IP" value={formatNumber(waiting)} detail="Paid, none free" tone={waiting > 0 ? "warn" : "default"} />
				<CardStat
					label="Idle cost"
					value={`${formatUsd(idleMonthlyCost)} a month`}
					detail={`${formatNumber(counts.available)} free x ${formatUsd(awsMonthlyCost)}. The add-on is at cost, so only IPs in use are paid back: idle ones come out of your pocket`}
					tone={counts.available > 0 ? "warn" : "default"}
				/>
				<CardStat label="Lease cost" value={`${formatUsd(monthlyCost)} a month`} detail={`${formatNumber(ips.length - counts.retired)} leased x ${formatUsd(awsMonthlyCost)}`} />
			</div>

			{managedPools > 0 && (
				<div className="flex flex-col gap-3 rounded-xl bg-card p-4 shadow-border sm:flex-row sm:items-center sm:justify-between">
					<p className="text-sm text-pretty">
						{formatNumber(managedPools)} account{managedPools === 1 ? " has" : "s have"} a managed IP pool from before standard IPs. AWS bills $15 a month for it
						whether it sends or not. Deleting it sends the account through shared IPs, and an account that paid for the add-on gets an IP from the inventory.
					</p>
					<Button variant="outline" disabled={isPending} onClick={() => run(convertManagedPoolsAction, (result) => `${result.converted} managed pool(s) deleted`)}>
						Delete managed pools
					</Button>
				</div>
			)}

			<div className="flex flex-col gap-3 rounded-xl bg-card p-4 shadow-border">
				<p className="text-sm text-pretty text-muted-foreground">
					AWS leases a dedicated IP through a support case (Service Quotas, Amazon SES, Desired Dedicated IP) and there is no API for it, so lease a few ahead of
					time. Then import them from AWS or add one by hand; it moves out of SES&apos;s default pool into a parking pool. A paid add-on gets its IP within the hour,
					or at once when one is added here.
				</p>
				<form onSubmit={add} className="flex flex-col gap-2 sm:flex-row">
					<Input value={ip} onChange={(event) => setIp(event.target.value)} placeholder="IPv4 address, like 203.0.113.25" aria-label="IP address" required className="sm:max-w-56" />
					<Input value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Note (optional)" aria-label="Note" maxLength={300} />
					<Button type="submit" disabled={isPending || !ip.trim()} className="sm:w-28">
						{isPending ? <Loader2 className="animate-spin" /> : <Plus />}
						Add
					</Button>
					<Button type="button" variant="outline" disabled={isPending} onClick={() => run(importIpsAction, (result) => `Imported ${result.added.length}, retired ${result.retired.length}${result.failed.length ? `, ${result.failed.length} failed` : ""}`)}>
						<Download />
						Import from AWS
					</Button>
				</form>
			</div>

			{ips.length > 0 && (
				<div className="overflow-hidden rounded-xl shadow-border">
					<Table>
						<TableHeader>
							<TableRow className="hover:bg-transparent">
								<TableHead className="pl-4">IP</TableHead>
								<TableHead>State</TableHead>
								<TableHead className="hidden md:table-cell">Account</TableHead>
								<TableHead className="hidden lg:table-cell">Warm-up</TableHead>
								<TableHead className="hidden xl:table-cell">Note</TableHead>
								<TableHead className="w-24 pr-4" />
							</TableRow>
						</TableHeader>
						<TableBody>
							{ips.map((doc) => (
								<TableRow key={doc.ip} className="tabular-nums">
									<TableCell className="pl-4 font-mono text-sm">{doc.ip}</TableCell>
									<TableCell>
										<BadgeStatus status={doc.state} label={STATE_LABELS[doc.state]} />
									</TableCell>
									<TableCell className="hidden max-w-0 md:table-cell">
										{doc.accountId ? (
											<a href={`/admin?account=${doc.accountId}`} className="block truncate font-mono text-xs underline-offset-2 hover:underline">
												{doc.accountId}
											</a>
										) : (
											<span className="text-xs text-muted-foreground">{doc.releasedAt ? `Returned ${formatDate(doc.releasedAt)}` : "Never used"}</span>
										)}
									</TableCell>
									<TableCell className="hidden text-xs text-muted-foreground lg:table-cell">{describeWarmup(doc)}</TableCell>
									<TableCell className="hidden max-w-0 xl:table-cell">
										<span className="block truncate text-xs text-muted-foreground" title={doc.notes}>
											{doc.notes}
										</span>
									</TableCell>
									<TableCell className="pr-4 text-right">
										{doc.state === "available" && (
											<Button variant="ghost" size="sm" disabled={isPending} onClick={() => run(() => retireIpAction(doc.ip), () => `${doc.ip} retired. Relinquish it in AWS too, or it keeps costing ${formatUsd(awsMonthlyCost)} a month`)}>
												Retire
											</Button>
										)}
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				</div>
			)}
		</div>
	);
}

const STATE_LABELS = { available: "Free", warming: "Warming up", assigned: "In use, warmed up", retired: "Retired" };

function describeWarmup(doc) {
	if (!doc.warmup) return doc.state === "assigned" ? "Done" : "";
	if (doc.warmup.completedAt) return "Done";
	return `Day ${doc.warmup.day ?? 1}, ${doc.warmup.share ?? 0}%${doc.warmup.holdReason ? " (held)" : ""}`;
}
