const { apiUrl } = require("../lib/api");

// get_contact by email. Nothing found is an empty result, so the Zap can create the subscriber instead.
module.exports = {
	key: "find_subscriber",
	noun: "Subscriber",
	display: { label: "Find subscriber", description: "Finds a subscriber by email address." },
	operation: {
		inputFields: [
			{ key: "email", label: "Email", required: true },
			{ key: "newsletter", label: "Newsletter", required: false, dynamic: "newsletter_list.id.name", helpText: "Needed when the address subscribes to several of your newsletters." },
		],
		perform: async (z, bundle) => {
			const { email, newsletter } = bundle.inputData;
			const query = newsletter ? `?newsletter=${encodeURIComponent(newsletter)}` : "";
			const response = await z.request({ url: apiUrl(bundle, `/contacts/${encodeURIComponent(String(email).trim())}${query}`), skipThrowForStatus: true });
			if (response.status === 404) return [];
			if (response.status >= 400) throw new z.errors.Error((response.data && response.data.error && response.data.error.message) || `FlockStack answered ${response.status}`);
			return [response.data];
		},
		sample: {
			id: "6650f1c2e9b1d4a012345678",
			newsletterId: "6650f1c2e9b1d4a0123456aa",
			email: "jane@example.com",
			status: "active",
			tier: "free",
			tags: ["podcast"],
			fields: { first_name: "Jane" },
			subscribedAt: "2026-10-20T09:30:00.000Z",
		},
	},
};
