import { notFound } from "next/navigation";
import FormWebhook from "@/components/FormWebhook";
import HeaderPage from "@/components/HeaderPage";
import TableWebhookDeliveries from "@/components/TableWebhookDeliveries";
import { runDashboardAction } from "@/lib/actions/dashboard";
import { WEBHOOK_EVENTS } from "@/lib/webhook-events";
import { MAX_DELIVERIES_PER_ENDPOINT } from "@/lib/webhooks";

export const metadata = { title: "Webhook" };

export default async function WebhookPage({ params }) {
	const { id } = await params;
	const [{ output: endpoint }, { output: log }, { output: newsletters }] = await Promise.all([
		runDashboardAction("get_webhook_endpoint", { id }),
		runDashboardAction("list_webhook_deliveries", { id, limit: MAX_DELIVERIES_PER_ENDPOINT }),
		runDashboardAction("list_newsletters"),
	]);
	if (!endpoint) notFound();

	return (
		<>
			<HeaderPage title={endpoint.description || new URL(endpoint.url).hostname} backHref="/webhooks" />
			<div className="flex flex-col gap-8">
				<FormWebhook
					key={endpoint.id}
					endpoint={endpoint}
					events={WEBHOOK_EVENTS.map(({ type, title }) => ({ type, title }))}
					newsletters={(newsletters?.newsletters ?? []).map(({ id: newsletterId, name }) => ({ id: newsletterId, name }))}
				/>
				<section style={{ "--stagger": 3 }} className="flex flex-col gap-3 animate-enter">
					<h2 className="text-sm font-medium text-muted-foreground">Deliveries</h2>
					<TableWebhookDeliveries endpointId={endpoint.id} deliveries={log?.deliveries ?? []} keep={MAX_DELIVERIES_PER_ENDPOINT} />
				</section>
			</div>
		</>
	);
}
