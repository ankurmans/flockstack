const { apiUrl } = require("../lib/api");

// The account's newsletters, for the Newsletter dropdowns. Hidden: a newsletter isn't something to start a Zap from.
module.exports = {
	key: "newsletter_list",
	noun: "Newsletter",
	display: { label: "List newsletters", description: "Lists your newsletters, for dropdowns.", hidden: true },
	operation: {
		perform: async (z, bundle) => {
			const response = await z.request({ url: apiUrl(bundle, "/newsletters") });
			return response.data.newsletters.map(({ id, name, slug }) => ({ id, name, slug }));
		},
		sample: { id: "6650f1c2e9b1d4a0123456aa", name: "Weekend notes", slug: "weekend-notes" },
	},
};
