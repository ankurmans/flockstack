const { apiUrl } = require("../lib/api");
const { fieldsField, newsletterField, tagsField, toContactInput } = require("./subscriber-fields");

// add_contact: a signup like the website's form. They get the welcome email, or the confirmation email when the
// newsletter asks new subscribers to confirm.
module.exports = {
	key: "add_subscriber",
	noun: "Subscriber",
	display: { label: "Add subscriber", description: "Signs someone up to your newsletter, as your signup form would." },
	operation: {
		inputFields: [
			{ key: "email", label: "Email", required: true },
			newsletterField,
			tagsField,
			fieldsField,
			{
				key: "resubscribe",
				label: "Bring back if unsubscribed",
				type: "boolean",
				required: false,
				default: "false",
				helpText: "Resubscribe someone who unsubscribed. Only use it when they asked to join again.",
			},
		],
		perform: async (z, bundle) => {
			const response = await z.request({
				url: apiUrl(bundle, "/contacts"),
				method: "POST",
				json: toContactInput(bundle.inputData, bundle.inputData.resubscribe === true || bundle.inputData.resubscribe === "true" ? { resubscribe: true } : {}),
			});
			return response.data;
		},
		sample: { id: "6650f1c2e9b1d4a012345678", email: "jane@example.com", newsletterId: "6650f1c2e9b1d4a0123456aa", status: "active", created: true, tags: ["podcast"] },
	},
};
