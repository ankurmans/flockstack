import { scoped } from "@/lib/account-scope";
import { actionError } from "@/lib/actions/errors";
import { parseFieldValue } from "@/lib/custom-fields-rules";
import CustomField from "@/models/CustomField";

export { MAX_FIELDS_PER_NEWSLETTER, MAX_TEXT_VALUE_LENGTH, getFieldKeyProblem, parseFieldValue, slugifyFieldKey } from "@/lib/custom-fields-rules";

export function listCustomFields(account, newsletterId) {
	return CustomField.find(scoped(account, { newsletterId })).sort({ createdAt: 1, _id: 1 }).lean();
}

export function toFieldOutput(field) {
	return {
		id: String(field._id),
		newsletterId: String(field.newsletterId),
		key: field.key,
		label: field.label,
		type: field.type,
		onSignupForm: Boolean(field.onSignupForm),
	};
}

// Turns { key: value } into a contact update. Unknown keys and bad values answer validation_failed, or are left out when
// ignoreUnknown is true.
export function buildFieldUpdate(definitions, values, { ignoreUnknown = false } = {}) {
	const byKey = new Map(definitions.map((field) => [field.key, field]));
	const set = {};
	const unset = {};
	for (const [key, input] of Object.entries(values ?? {})) {
		const definition = byKey.get(key);
		if (!definition) {
			if (ignoreUnknown) continue;
			throw actionError("validation_failed", `fields.${key}: the newsletter has no such custom field`);
		}
		const parsed = parseFieldValue(definition.type, input);
		if (parsed.problem) throw actionError("validation_failed", `fields.${key}: ${parsed.problem}`);
		if (parsed.value === null) unset[`fields.${key}`] = 1;
		else set[`fields.${key}`] = parsed.value;
	}
	return { set, unset, isEmpty: Object.keys(set).length + Object.keys(unset).length === 0 };
}

export function toContactUpdate({ set, unset }) {
	return {
		...(Object.keys(set).length > 0 && { $set: set }),
		...(Object.keys(unset).length > 0 && { $unset: unset }),
	};
}

// What a contact's fields look like to callers: every field of the newsletter that has a value.
export function toFieldValues(contact) {
	return contact.fields && typeof contact.fields === "object" ? { ...contact.fields } : {};
}
