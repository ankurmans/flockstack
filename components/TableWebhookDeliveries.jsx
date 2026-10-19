import BadgeStatus from "@/components/BadgeStatus";
import ButtonResendDelivery from "@/components/ButtonResendDelivery";
import { formatRelative, formatSendTime } from "@/lib/format";

// An endpoint's latest deliveries, newest first. Each opens to the body that was sent and the answer to its last attempt.
export default function TableWebhookDeliveries({ endpointId, deliveries, keep }) {
	if (deliveries.length === 0) {
		return <p className="rounded-xl px-4 py-6 text-center text-sm text-muted-foreground shadow-border">Nothing sent yet. Send a test event to try it.</p>;
	}

	return (
		<div className="flex flex-col gap-2">
			<ul className="overflow-hidden rounded-xl bg-card shadow-border divide-y divide-border/60">
				{deliveries.map((delivery) => (
					<li key={delivery.id}>
						<details className="group">
							<summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-2.5 transition-colors duration-150 hover:bg-muted/40 [&::-webkit-details-marker]:hidden">
								<span className="flex min-w-0 flex-1 flex-col gap-0.5">
									<span className="truncate font-mono text-[13px]">{delivery.type}</span>
									<span className="truncate text-xs text-muted-foreground">{describe(delivery)}</span>
								</span>
								<BadgeStatus status={delivery.status} />
							</summary>
							<div className="flex flex-col gap-3 border-t border-border/60 px-4 py-3">
								<dl className="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-4 gap-y-1 text-xs">
									<dt className="text-muted-foreground">webhook-id</dt>
									<dd className="truncate font-mono">{delivery.messageId}</dd>
									<dt className="text-muted-foreground">Answer</dt>
									<dd className="font-mono break-words">{[delivery.responseStatus, delivery.error].filter(Boolean).join(" · ") || "None yet"}</dd>
									{delivery.responseBody && (
										<>
											<dt className="text-muted-foreground">Answer body</dt>
											<dd className="font-mono break-words">{delivery.responseBody}</dd>
										</>
									)}
								</dl>
								<pre className="max-h-72 overflow-auto rounded-lg bg-muted p-3 font-mono text-[12px] leading-5">{pretty(delivery.payload)}</pre>
								{delivery.status !== "pending" && (
									<div className="flex justify-end">
										<ButtonResendDelivery endpointId={endpointId} deliveryId={delivery.id} />
									</div>
								)}
							</div>
						</details>
					</li>
				))}
			</ul>
			<p className="text-xs text-muted-foreground">The latest {keep} deliveries are kept.</p>
		</div>
	);
}

function describe({ status, attempts, createdAt, nextAttemptAt, test }) {
	const tries = attempts === 1 ? "1 attempt" : `${attempts} attempts`;
	const parts = [test && "Test", formatRelative(createdAt), attempts > 0 && tries, status === "pending" && nextAttemptAt && `next try ${formatSendTime(nextAttemptAt)} UTC`];
	return parts.filter(Boolean).join(" · ");
}

function pretty(payload) {
	try {
		return JSON.stringify(JSON.parse(payload), null, 2);
	} catch {
		return payload;
	}
}
