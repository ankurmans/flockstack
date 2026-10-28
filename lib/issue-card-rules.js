// Whether an issue's email starts with its share card (docs/VISUALS-DESIGN.md, Email), with no imports, so the dashboard's client
// code can say what the default is without bringing in what draws or signs the card (lib/issue-card.js).

// Made by a briefing (lib/briefings-delivery.js): its campaigns carry a briefing:<id>:<slot> externalId.
export function isBriefingCampaign(campaign) {
	return campaign?.source === "briefing" || /^briefing:/.test(String(campaign?.externalId ?? ""));
}

// The campaign's own word, else the newsletter's, else on for a briefing's issue and off for any other.
export function isIssueCardOn(newsletter, campaign) {
	if (typeof campaign?.issueCard === "boolean") return campaign.issueCard;
	if (typeof newsletter?.brand?.issueCard === "boolean") return newsletter.brand.issueCard;
	return isBriefingCampaign(campaign);
}
