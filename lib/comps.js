import "server-only";
import { scoped } from "@/lib/account-scope";
import { actionError } from "@/lib/actions/errors";
import { getActiveGrant } from "@/lib/grants";
import { grantAccess } from "@/lib/grant-access";
import { isObjectIdString, normalizeEmail } from "@/lib/validation";
import Contact from "@/models/Contact";

// Complimentary access: the writer gives a contact paid access by hand until a day, for press, partners or a favor. It is a grant of
// kind comp (lib/grant-access.js): shown apart from paying readers, never counted in what a tier earns, and gone on its day.
export const MAX_COMP_YEARS = 5;

// The contact a comp is for, by ID or address. It has to be on the list already: giving paid issues to someone who never signed up
// would email them without their say.
export async function findCompContact(account, newsletter, reference) {
	const value = String(reference ?? "").trim();
	const email = normalizeEmail(value);
	const filter = isObjectIdString(value) ? { _id: value } : email ? { email } : null;
	const contact = filter ? await Contact.findOne(scoped(account, { newsletterId: newsletter._id, ...filter })).lean() : null;
	if (!contact) throw actionError("not_found", "Contact not found: add them to the newsletter first (add_contact)");
	return contact;
}

export function readCompEnd(text) {
	const date = new Date(text);
	if (!Number.isFinite(date.getTime()) || date.getTime() <= Date.now()) throw actionError("validation_failed", "endsAt: use a date and time in the future, e.g. 2026-12-31T23:59:59Z");
	if (date.getTime() > Date.now() + MAX_COMP_YEARS * 366 * 86_400_000) throw actionError("validation_failed", `endsAt: at most ${MAX_COMP_YEARS} years from now`);
	return date;
}

export async function giveComp({ account, newsletter, contact, tierId, endsAt, note }) {
	if (contact.status !== "active") throw actionError("conflict", "Only an active contact can have comp access: they have to be getting the newsletter");
	const existing = getActiveGrant(contact);
	if (existing?.kind === "gift") throw actionError("conflict", "This reader has a gift until it ends: revoke it with revoke_comp_access first, or wait");
	return grantAccess({ account, newsletter, contact, tierId, until: endsAt, kind: "comp", note });
}
