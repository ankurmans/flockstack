import Link from "next/link";
import { ArrowUpRight, ChevronRight, Webhook } from "lucide-react";
import BadgeStatus from "@/components/BadgeStatus";
import DialogCreateWebhook from "@/components/DialogCreateWebhook";
import GatePlan from "@/components/GatePlan";
import HeaderPage from "@/components/HeaderPage";
import StateEmpty from "@/components/StateEmpty";
import { Button } from "@/components/ui/button";
import { runDashboardAction } from "@/lib/actions/dashboard";
import { formatRelative } from "@/lib/format";
import { WEBHOOK_EVENTS } from "@/lib/webhook-events";

export const metadata = { title: "Webhooks" };

export default async function WebhooksPage() {
	const [{ output }, { output: newsletters }] = await Promise.all([runDashboardAction("list_webhook_endpoints"), runDashboardAction("list_newsletters")]);
	const endpoints = output?.endpoints ?? [];
	const limit = output?.limit ?? null;
	const isFull = limit !== null && endpoints.length >= limit;
	const events = WEBHOOK_EVENTS.map(({ type, title }) => ({ type, title }));

	return (
		<>
			<HeaderPage title="Webhooks">
				<Button asChild variant="outline">
					<Link href="/docs/webhooks">
						Docs
						<ArrowUpRight data-icon="inline-end" className="opacity-60" />
					</Link>
				</Button>
				<GatePlan reason="webhook">
					<DialogCreateWebhook events={events} newsletters={(newsletters?.newsletters ?? []).map(({ id, name }) => ({ id, name }))} isFull={isFull} limit={limit} />
				</GatePlan>
			</HeaderPage>

			<div className="flex flex-col gap-4">
				{endpoints.length === 0 ? (
					<StateEmpty icon={Webhook} title="No webhooks yet">
						<p className="max-w-sm text-sm text-pretty text-muted-foreground">
							FlockStack can tell your own server, Zapier or Make when someone subscribes, a campaign goes out or an order is paid.
						</p>
					</StateEmpty>
				) : (
					<ul className="overflow-hidden rounded-xl bg-card shadow-border animate-enter divide-y divide-border/60">
						{endpoints.map((endpoint) => (
							<li key={endpoint.id}>
								<Link
									href={`/webhooks/${endpoint.id}`}
									className="flex items-center gap-3 px-4 py-3 transition-colors duration-150 hover:bg-muted/40"
								>
									<span className="flex min-w-0 flex-1 flex-col gap-0.5">
										<span className="truncate font-mono text-[13px]">{endpoint.url}</span>
										<span className="truncate text-xs text-muted-foreground">
											{[endpoint.description, describeEvents(endpoint.events), describeLast(endpoint)].filter(Boolean).join(" · ")}
										</span>
									</span>
									<BadgeStatus status={getState(endpoint)} label={STATE_LABELS[getState(endpoint)]} />
									<ChevronRight className="size-4 shrink-0 text-muted-foreground" />
								</Link>
							</li>
						))}
					</ul>
				)}
				{limit !== null && (
					<p className="text-xs text-muted-foreground">
						{endpoints.length} of {limit} endpoints on your plan. Each Zapier or Make trigger uses one.
					</p>
				)}
			</div>
		</>
	);
}

const STATE_LABELS = { active: "On", failing: "Failing", paused: "Off" };

function getState(endpoint) {
	if (!endpoint.enabled) return "paused";
	return endpoint.failingSince ? "failing" : "active";
}

function describeEvents(events) {
	if (events.length === 0) return "Every event";
	return events.length === 1 ? events[0] : `${events.length} events`;
}

function describeLast({ lastSuccessAt, lastFailureAt }) {
	if (!lastSuccessAt && !lastFailureAt) return "Nothing sent yet";
	const isSuccessLast = lastSuccessAt && (!lastFailureAt || lastSuccessAt > lastFailureAt);
	return isSuccessLast ? `Last delivered ${formatRelative(lastSuccessAt)}` : `Last failed ${formatRelative(lastFailureAt)}`;
}
