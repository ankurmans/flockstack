import { getErrorStatus, toActionError } from "@/lib/actions/errors";
import { runAction } from "@/lib/actions/run-action";
import { getCurrentAccount } from "@/lib/auth";

const FILTERS = ["actor", "actorType", "client", "action", "newsletter", "status"];

// The Agent activity page's Export CSV: export_agent_activity with the page's filters, as a file. The signed-in account's own log only.
export async function GET(request) {
	const current = await getCurrentAccount();
	if (!current) return Response.json({ error: "Unauthorized" }, { status: 401 });
	const params = new URL(request.url).searchParams;
	const input = Object.fromEntries(FILTERS.map((name) => [name, params.get(name)]).filter(([, value]) => value));
	if (params.get("days")) input.days = Number(params.get("days"));
	try {
		const { csv } = await runAction("export_agent_activity", { ...current, via: "dashboard", input });
		return new Response(csv, {
			headers: {
				"content-type": "text/csv; charset=utf-8",
				"content-disposition": `attachment; filename="agent-activity-${new Date().toISOString().slice(0, 10)}.csv"`,
				"cache-control": "private, no-store",
				"x-content-type-options": "nosniff",
			},
		});
	} catch (error) {
		const { code, message } = toActionError(error);
		return Response.json({ error: message, code }, { status: getErrorStatus(code) });
	}
}
