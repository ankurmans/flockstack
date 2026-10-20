import mongoose from "../lib/docdb/index.js";
import { accountScoped } from "../lib/account-scope.js";

export const POST_IMPORT_STATUSES = ["ready", "queued", "running", "done", "failed"];

const counter = { type: Number, default: 0 };

// One archive import from Substack, beehiiv, WordPress or Ghost (lib/post-import.js). The export is read when it is
// uploaded: its posts wait in private storage in chunks, the preview here, until the owner starts it (ready). Then
// background jobs turn the posts into sent issues, a step at a time; state is where the next step picks up.
const postImportSchema = new mongoose.Schema(
	{
		newsletterId: { type: mongoose.Schema.Types.ObjectId, ref: "Newsletter", required: true },
		userId: { type: mongoose.Schema.Types.ObjectId },
		via: { type: String },
		source: { type: String, required: true },
		fileName: { type: String },
		fileBytes: { type: Number, default: 0 },
		// The old site's address: Ghost's __GHOST_URL__ and relative links resolve against it.
		siteUrl: { type: String },
		status: { type: String, enum: POST_IMPORT_STATUSES, default: "ready" },
		error: { type: String },
		// Chunk files of parsed posts, newest first, and how many posts they hold.
		chunks: { type: Number, default: 0 },
		preview: {
			posts: counter,
			paid: counter,
			titles: { type: [String], default: undefined },
			oldest: { type: Date },
			newest: { type: Date },
			skipped: {
				drafts: counter,
				other: counter,
				missingContent: counter,
			},
		},
		// The plan's caps when it started: new posts this import may add, and image bytes it may store.
		limits: {
			posts: { type: Number },
			imageBytes: { type: Number },
		},
		state: { type: mongoose.Schema.Types.Mixed },
		attempts: { type: Number, default: 0 },
		lockedUntil: { type: Date },
		counts: {
			imported: counter,
			existing: counter,
			overLimit: counter,
			failed: counter,
			images: counter,
			imageFailures: counter,
			imageBytes: counter,
			redirects: counter,
		},
		// A few posts that didn't come, with why: { title, problem }.
		problems: { type: [mongoose.Schema.Types.Mixed], default: undefined },
		startedAt: { type: Date },
		finishedAt: { type: Date },
		emailedAt: { type: Date },
	},
	{ timestamps: true }
);

postImportSchema.plugin(accountScoped);
postImportSchema.index({ accountId: 1, createdAt: -1 });

export default mongoose.models.PostImport || mongoose.model("PostImport", postImportSchema);
