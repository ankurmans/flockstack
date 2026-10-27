// Include means any chosen list; exclusions always win. An unknown or archived include still narrows a queued send.
export function isInMailingAudience(contact, campaign) {
	const member = new Set(contact.listIds ?? []);
	return (!(campaign.listIds?.length) || campaign.listIds.some((id) => member.has(id))) && !(campaign.excludeListIds ?? []).some((id) => member.has(id));
}

export function mailingAudienceFilter({ listIds = [], excludeListIds = [] }) {
	return [...(listIds.length ? [{ listIds: { $in: listIds } }] : []), ...(excludeListIds.length ? [{ listIds: { $nin: excludeListIds } }] : [])];
}
