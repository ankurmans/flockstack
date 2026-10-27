// FlockStack's Zapier app, for the Zapier Platform CLI (zapier push). Triggers are REST hooks on FlockStack's webhooks;
// actions and the search call its REST API with the account's API key. /docs/zapier-make in the app says how to
// install it as a private app.
const zapier = require("zapier-platform-core");
const packageJson = require("./package.json");
const authentication = require("./authentication");
const { addApiKey, handleErrors } = require("./lib/api");
const events = require("./lib/events");
const { makeEventTrigger } = require("./triggers/event");
const newsletterList = require("./triggers/newsletter-list");
const addSubscriber = require("./creates/add-subscriber");
const updateSubscriber = require("./creates/update-subscriber");
const addTag = require("./creates/add-tag");
const findSubscriber = require("./searches/find-subscriber");

const eventTriggers = events.map(makeEventTrigger);

module.exports = {
	version: packageJson.version,
	platformVersion: zapier.version,
	flags: { cleanInputData: false },
	authentication,
	beforeRequest: [addApiKey],
	afterResponse: [handleErrors],
	triggers: Object.fromEntries([...eventTriggers, newsletterList].map((trigger) => [trigger.key, trigger])),
	creates: Object.fromEntries([addSubscriber, updateSubscriber, addTag].map((create) => [create.key, create])),
	searches: { [findSubscriber.key]: findSubscriber },
	searchOrCreates: {
		[findSubscriber.key]: { key: findSubscriber.key, display: { label: "Find or add subscriber", description: "Finds a subscriber by email, or signs them up." }, search: findSubscriber.key, create: addSubscriber.key },
	},
};
