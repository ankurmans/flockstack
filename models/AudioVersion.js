import mongoose from "../lib/docdb/index.js";
import { accountScoped } from "../lib/account-scope.js";

export const AUDIO_STATUSES = ["queued", "running", "ready", "failed"];
export const AUDIO_SCOPES = ["public", "paid"];

// The audio version of one issue (lib/audio.js). The job fields say how far the making has got; `file` is what listeners
// get and stays until a newer file replaces it, so an issue re-created after an edit keeps playing the old audio meanwhile.
const audioVersionSchema = new mongoose.Schema(
	{
		newsletterId: { type: mongoose.Schema.Types.ObjectId, ref: "Newsletter", required: true },
		campaignId: { type: mongoose.Schema.Types.ObjectId, ref: "Campaign", required: true },
		userId: { type: mongoose.Schema.Types.ObjectId },
		via: { type: String },
		status: { type: String, enum: AUDIO_STATUSES, default: "queued" },
		voiceId: { type: String, required: true },
		model: { type: String, required: true },
		format: { type: String, required: true },
		// public: the part of the issue everyone reads, and anyone may hear. paid: an issue for paid subscribers only, whole,
		// heard by paid readers only.
		scope: { type: String, enum: AUDIO_SCOPES, required: true },
		characters: { type: Number, default: 0 },
		chunks: { type: Number, default: 0 },
		textHash: { type: String },
		// Where the next step picks up: parts done so far, each with its size and the request id the voice service gave it.
		state: { type: mongoose.Schema.Types.Mixed },
		// The month's quota (models/AudioUsage.js) holds `reserved` characters for the job from the start. When it ends, ready or
		// stopped, charsDone of them are used for good and the rest go back, once: settledAt says it happened.
		month: { type: String },
		reserved: { type: Number, default: 0 },
		charsDone: { type: Number, default: 0 },
		// Of charsDone, what an earlier run of this job already counted as used (a failed job started again keeps its parts).
		usedSettled: { type: Number, default: 0 },
		settledAt: { type: Date },
		// Counts the jobs this issue's audio has had: the file of one never overwrites the file of another.
		generation: { type: Number, default: 0 },
		attempts: { type: Number, default: 0 },
		lockedUntil: { type: Date },
		error: { type: String },
		errorPart: { type: Number },
		emailLink: { type: Boolean, default: false },
		file: {
			key: { type: String },
			bytes: { type: Number },
			seconds: { type: Number },
			voiceId: { type: String },
			scope: { type: String, enum: AUDIO_SCOPES },
			characters: { type: Number },
			textHash: { type: String },
			readyAt: { type: Date },
		},
		startedAt: { type: Date },
		finishedAt: { type: Date },
	},
	{ timestamps: true }
);

audioVersionSchema.plugin(accountScoped);
audioVersionSchema.index({ campaignId: 1 }, { unique: true });
audioVersionSchema.index({ newsletterId: 1, "file.readyAt": -1 });

export default mongoose.models.AudioVersion || mongoose.model("AudioVersion", audioVersionSchema);
