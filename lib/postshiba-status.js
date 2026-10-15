import "server-only";
import { sendAlert } from "@/lib/alerts";
import { getEmailProviderId } from "@/lib/config";
import { connectDb } from "@/lib/db";
import { isEmailProviderConfigured } from "@/lib/email-provider";
import { getHeldTenantIds, getTeamStatusAlerts } from "@/lib/email-provider/postshiba-rules";
import { getTeamStatus } from "@/lib/postshiba";
import Account from "@/models/Account";

// The same problem found every hour is emailed once a day; Telegram has its own 6 hours (lib/alerts.js).
const COOLDOWN_MINUTES = 24 * 60;
// A key or team id PostShiba doesn't take. An outage or a slow answer waits for the next hour.
const REFUSALS = new Set([401, 403, 404]);

async function findHeldAccounts(tenantIds) {
	if (tenantIds.length === 0) return new Map();
	const accounts = await Account.find({ "postshiba.tenantId": { $in: tenantIds } }).select({ "postshiba.tenantId": 1 }).lean();
	return new Map(accounts.map((account) => [account.postshiba.tenantId, String(account._id)]));
}

// Hourly (app/api/cron/hourly): what PostShiba says stops MailCheap's sends right now, as alerts for the admins.
export async function checkPostshibaStatus() {
	if (getEmailProviderId() !== "postshiba" || !isEmailProviderConfigured()) return { skipped: "PostShiba isn't the email provider" };
	let status;
	try {
		status = await getTeamStatus();
	} catch (error) {
		if (REFUSALS.has(error.status)) {
			await sendAlert({
				accountId: null,
				key: "postshiba-status-refused",
				title: "PostShiba refused the status check",
				detail: `${error.message}.`,
				action: "Check POSTSHIBA_API_KEY and POSTSHIBA_TEAM_ID: every send needs them too.",
				link: "https://app.postshiba.com",
				cooldownMinutes: COOLDOWN_MINUTES,
			});
		}
		return { failed: error.message };
	}
	await connectDb();
	const alerts = getTeamStatusAlerts(status, await findHeldAccounts(getHeldTenantIds(status)));
	for (const alert of alerts) await sendAlert({ accountId: null, cooldownMinutes: COOLDOWN_MINUTES, ...alert });
	return { alerts: alerts.map(({ key }) => key) };
}
