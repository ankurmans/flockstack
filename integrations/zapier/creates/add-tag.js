const { apiUrl } = require("../lib/api");
const { newsletterField } = require("./subscriber-fields");

// add_tag: segments filter by tags and automations can start from one.
module.exports = {
	key: "add_tag",
	noun: "Tag",
	display: { label: "Add tag to subscriber", description: "Gives a subscriber a tag, which can start an automation." },
	operation: {
		inputFields: [
			{ key: "subscriber", label: "Subscriber", required: true, helpText: "Their email address or FlockStack ID." },
			{ ...newsletterField, helpText: "Needed when the address subscribes to several of your newsletters." },
			{ key: "tag", label: "Tag", required: true },
		],
		perform: async (z, bundle) => {
			const { subscriber, newsletter, tag } = bundle.inputData;
			const response = await z.request({
				url: apiUrl(bundle, `/contacts/${encodeURIComponent(String(subscriber).trim())}/tags`),
				method: "POST",
				json: { tag, ...(newsletter && { newsletter }) },
			});
			return response.data;
		},
		sample: { id: "6650f1c2e9b1d4a012345678", email: "jane@example.com", tags: ["podcast", "vip"], changed: true },
	},
};
