const { apiUrl } = require("../lib/api");
const { fieldsField, newsletterField, tagsField, toContactInput } = require("./subscriber-fields");

// add_contact on an address that is already a subscriber adds its tags and sets its fields, and changes nothing else.
// An address that isn't one yet is signed up, like Add subscriber.
module.exports = {
	key: "update_subscriber",
	noun: "Subscriber",
	display: {
		label: "Add or update subscriber",
		description: "Adds tags and sets custom fields on a subscriber, found by email. Someone who isn't subscribed yet is signed up.",
	},
	operation: {
		inputFields: [{ key: "email", label: "Email", required: true }, newsletterField, tagsField, fieldsField],
		perform: async (z, bundle) => {
			const response = await z.request({ url: apiUrl(bundle, "/contacts"), method: "POST", json: toContactInput(bundle.inputData) });
			return response.data;
		},
		sample: { id: "6650f1c2e9b1d4a012345678", email: "jane@example.com", newsletterId: "6650f1c2e9b1d4a0123456aa", status: "active", created: false, tags: ["podcast", "vip"] },
	},
};
