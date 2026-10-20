import mongoose from "../lib/docdb/index.js";
import { accountScoped } from "../lib/account-scope.js";

// One contact on a saved list: a static segment (lib/segment-snapshots.js) is the contacts a segment matched when it
// was saved.
const segmentMemberSchema = new mongoose.Schema({
	segmentId: { type: mongoose.Schema.Types.ObjectId, ref: "Segment", required: true },
	contactId: { type: mongoose.Schema.Types.ObjectId, ref: "Contact", required: true },
});

segmentMemberSchema.plugin(accountScoped);
segmentMemberSchema.index({ segmentId: 1, contactId: 1 }, { unique: true });

export default mongoose.models.SegmentMember || mongoose.model("SegmentMember", segmentMemberSchema);
