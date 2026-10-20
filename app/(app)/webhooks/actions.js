"use server";

import { revalidatePath } from "next/cache";
import { runDashboardAction, toFormError } from "@/lib/actions/dashboard";

// The form's events: the boxes ticked, or none for every event.
function readEvents(formData) {
	return formData.getAll("events").map(String);
}

export async function createWebhookEndpoint(_state, formData) {
	const newsletter = String(formData.get("newsletter") ?? "");
	const { output, failure } = await runDashboardAction("create_webhook_endpoint", {
		url: String(formData.get("url") ?? "").slice(0, 2000),
		description: String(formData.get("description") ?? "").slice(0, 200),
		events: formData.get("allEvents") === "on" ? [] : readEvents(formData),
		...(newsletter && newsletter !== "all" && { newsletter }),
	});
	if (failure) return toFormError(failure);
	revalidatePath("/webhooks");
	return { id: output.endpoint.id, secret: output.secret };
}

export async function updateWebhookEndpoint(id, fields) {
	const { output, failure } = await runDashboardAction("update_webhook_endpoint", {
		id: String(id),
		url: String(fields.url ?? ""),
		description: String(fields.description ?? ""),
		events: Array.isArray(fields.events) ? fields.events.map(String) : [],
		newsletter: fields.newsletterId ? String(fields.newsletterId) : null,
		enabled: fields.enabled === true,
	});
	if (failure) return toFormError(failure);
	revalidatePath("/webhooks");
	revalidatePath(`/webhooks/${id}`);
	return { endpoint: output, savedAt: Date.now() };
}

export async function deleteWebhookEndpoint(id) {
	const { failure } = await runDashboardAction("delete_webhook_endpoint", { id: String(id) });
	if (failure) return toFormError(failure);
	revalidatePath("/webhooks");
	return { ok: true };
}

export async function rotateWebhookSecret(id) {
	const { output, failure } = await runDashboardAction("rotate_webhook_secret", { id: String(id) });
	if (failure) return toFormError(failure);
	return { secret: output.secret };
}

export async function sendTestWebhook(id) {
	const { failure } = await runDashboardAction("send_test_webhook", { id: String(id) });
	if (failure) return toFormError(failure);
	revalidatePath(`/webhooks/${id}`);
	return { ok: true };
}

export async function resendWebhookDelivery(id, deliveryId) {
	const { failure } = await runDashboardAction("resend_webhook_delivery", { id: String(id), deliveryId: String(deliveryId) });
	if (failure) return toFormError(failure);
	revalidatePath(`/webhooks/${id}`);
	return { ok: true };
}
