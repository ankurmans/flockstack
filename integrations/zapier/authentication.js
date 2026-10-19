const { apiUrl } = require("./lib/api");

// FlockStack's own API keys, made on the dashboard's API keys page. A full access key: triggers add webhooks.
module.exports = {
	type: "custom",
	fields: [
		{
			key: "apiKey",
			label: "API key",
			type: "password",
			required: true,
			helpText: "A full access key from the API keys page of your FlockStack dashboard.",
		},
		{
			key: "region",
			label: "Region",
			required: true,
			default: "us",
			choices: { us: "United States (flockstack.io)", eu: "European Union (eu.flockstack.io)" },
			helpText: "Where your account lives: keys starting with mc_eu_ are European Union keys.",
		},
		{
			key: "serverUrl",
			label: "Your own server",
			required: false,
			helpText: "Only if you host FlockStack yourself: its address, e.g. https://news.example.com. Leave empty on FlockStack Cloud.",
		},
	],
	test: (z, bundle) => z.request({ url: apiUrl(bundle, "/newsletters") }).then((response) => response.data),
	connectionLabel: (z, bundle) => {
		const [first] = (bundle.inputData && bundle.inputData.newsletters) || [];
		return first ? first.name : "FlockStack";
	},
};
