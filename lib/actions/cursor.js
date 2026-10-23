import "server-only";
import { Types } from "@/lib/docdb";
import { actionError } from "@/lib/actions/errors";
import { isObjectIdString } from "@/lib/validation";

// Paging by cursor, apart from lib/actions/shared.js: a dashboard page that lists newest first (the agent activity log) needs these two,
// and not the zod schemas of the actions that sit beside them there.
// The position of a page's last item, in lists sorted newest first with ties broken by ID.
export function encodeCursor(date, id) {
	return Buffer.from(JSON.stringify([date.toISOString(), String(id)])).toString("base64url");
}

// The items after a cursor's position, on the date field the list is sorted by.
export function afterCursor(cursor, field) {
	const { date, id } = decodeCursor(cursor);
	return { $or: [{ [field]: { $lt: date } }, { [field]: date, _id: { $lt: id } }] };
}

function decodeCursor(cursor) {
	try {
		const [at, id] = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
		const date = new Date(at);
		if (Number.isFinite(date.getTime()) && isObjectIdString(id)) return { date, id: new Types.ObjectId(id) };
	} catch {
		// Falls through to the error below.
	}
	throw actionError("validation_failed", "cursor: use the nextCursor of the previous page");
}
