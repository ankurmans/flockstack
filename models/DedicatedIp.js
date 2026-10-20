import mongoose from "../lib/docdb/index.js";

// Standard dedicated IPs the AWS account leased (lib/ip-inventory.js), one document each. AWS leases them through a support
// case, so an admin adds them here after it's done (or imports them from AWS), and FlockStack moves them between SES pools.
//   available: parked in the inventory pool, nobody's.
//   warming:   in an account's own pool, which gets a growing share of the account's email (lib/ip-warmup-rules.js).
//   assigned:  in an account's own pool, warmed up: all of the account's email goes through it.
//   retired:   no longer used. The AWS lease ends with a support case to relinquish it.
export const IP_STATES = ["available", "assigned", "warming", "retired"];

const dedicatedIpSchema = new mongoose.Schema(
	{
		ip: { type: String, required: true, unique: true },
		state: { type: String, enum: IP_STATES, default: "available", required: true },
		// The SES pool it's in now: the inventory pool while available, the account's own while assigned or warming.
		poolName: { type: String },
		accountId: { type: mongoose.Schema.Types.ObjectId, ref: "Account" },
		leasedAt: { type: Date },
		assignedAt: { type: Date },
		// The last account it was given back from, and when: it carries that account's sending history to the next one.
		lastAccountId: { type: mongoose.Schema.Types.ObjectId, ref: "Account" },
		releasedAt: { type: Date },
		retiredAt: { type: Date },
		notes: { type: String, trim: true, maxlength: 1000 },
	},
	{ timestamps: true }
);

dedicatedIpSchema.index({ state: 1, releasedAt: 1, leasedAt: 1 });

export default mongoose.models.DedicatedIp || mongoose.model("DedicatedIp", dedicatedIpSchema);
