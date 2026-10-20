import "server-only";
import { scoped } from "@/lib/account-scope";
import { actionError } from "@/lib/actions/errors";
import { FREE_PLAN, isOnFreeTier } from "@/lib/plans";
import Automation from "@/models/Automation";

// The Free plan has FREE_PLAN.automations, besides the welcome email (a newsletter setting). An account whose plan lapsed
// to Free keeps the ones it has, running; it just can't make more until it is under the number or upgrades.
export async function ensureFreeAutomationRoom(account) {
	if (!isOnFreeTier(account)) return;
	const count = await Automation.countDocuments(scoped(account, { status: { $ne: "deleted" } }));
	if (count >= FREE_PLAN.automations) {
		throw actionError("conflict", `The Free plan has up to ${FREE_PLAN.automations} automations, besides the welcome email. Delete one you don't use, or upgrade.`);
	}
}
