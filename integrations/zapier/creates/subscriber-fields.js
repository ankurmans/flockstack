// The fields add and update share, and how they become add_contact's input.
const newsletterField = {
	key: "newsletter",
	label: "Newsletter",
	required: false,
	dynamic: "newsletter_list.id.name",
	helpText: "Leave empty for your first newsletter.",
};

const tagsField = { key: "tags", label: "Tags", required: false, list: true, helpText: "Tags to add. Tags the subscriber has stay." };

const fieldsField = {
	key: "fields",
	label: "Custom fields",
	required: false,
	dict: true,
	helpText: "Custom field values by field key, e.g. first_name. The newsletter has to have the field.",
};

function toContactInput(inputData, extra = {}) {
	const tags = (inputData.tags || []).map((tag) => String(tag).trim()).filter(Boolean);
	const fields = inputData.fields && Object.keys(inputData.fields).length > 0 ? inputData.fields : undefined;
	return {
		email: String(inputData.email || "").trim(),
		source: "zapier",
		...(inputData.newsletter && { newsletter: inputData.newsletter }),
		...(tags.length > 0 && { tags }),
		...(fields && { fields }),
		...extra,
	};
}

module.exports = { newsletterField, tagsField, fieldsField, toContactInput };
