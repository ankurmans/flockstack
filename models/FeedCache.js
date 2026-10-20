import mongoose from "../lib/docdb/index.js";
import { accountScoped } from "../lib/account-scope.js";

// The items of a feed an account's issues read (lib/feed-fetch.js), kept for a few minutes so a send, a test email and a
// series run in a row ask the feed's server once. key: the feed's address. Kept apart for each account, so a feed behind
// a private address is never shown to another one.
const feedCacheSchema = new mongoose.Schema(
	{
		key: { type: String, required: true },
		title: { type: String },
		items: { type: [mongoose.Schema.Types.Mixed], default: [] },
		fetchedAt: { type: Date, required: true },
	},
	{ timestamps: true }
);

feedCacheSchema.plugin(accountScoped);
feedCacheSchema.index({ accountId: 1, key: 1 }, { unique: true });
feedCacheSchema.index({ fetchedAt: 1 });

export default mongoose.models.FeedCache || mongoose.model("FeedCache", feedCacheSchema);
