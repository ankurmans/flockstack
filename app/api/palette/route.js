import { getErrorStatus, toActionError } from "@/lib/actions/errors";
import { runAction } from "@/lib/actions/run-action";
import { getCurrentAccount } from "@/lib/auth";
import { MIN_SEARCH_LENGTH } from "@/lib/palette";
import { getSelectedNewsletter } from "@/lib/selected-newsletter";

const LIMIT = 5;

// The command palette's search: the account's issues by subject, and the open newsletter's contacts by the start of their
// address, through the same list actions as the API. Only the dashboard's own pages ask.
export async function GET(request) {
	const site = request.headers.get("sec-fetch-site");
	if (site && site !== "same-origin") return Response.json({ error: "Forbidden" }, { status: 403 });
	const current = await getCurrentAccount();
	if (!current) return Response.json({ error: "Unauthorized" }, { status: 401 });

	const search = (new URL(request.url).searchParams.get("q") ?? "").trim().slice(0, 100);
	if (search.length < MIN_SEARCH_LENGTH) return Response.json({ campaigns: [], contacts: [] }, { headers: { "Cache-Control": "no-store" } });
	try {
		const { selected } = await getSelectedNewsletter();
		const run = (name, input) => runAction(name, { ...current, via: "dashboard", input });
		const [campaigns, contacts] = await Promise.all([
			run("list_campaigns", { search, limit: LIMIT }),
			selected ? run("list_contacts", { newsletter: String(selected._id), search: search.toLowerCase(), limit: LIMIT }) : { contacts: [] },
		]);
		return Response.json(
			{
				campaigns: campaigns.campaigns.map(({ id, subject, status }) => ({ id, subject, status })),
				contacts: contacts.contacts.map(({ id, email, status }) => ({ id, email, status })),
			},
			{ headers: { "Cache-Control": "no-store" } }
		);
	} catch (error) {
		const { code, message } = toActionError(error);
		return Response.json({ error: message, code }, { status: getErrorStatus(code) });
	}
}
