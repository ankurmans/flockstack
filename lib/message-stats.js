function countIf(field) {
	return { $sum: { $cond: [{ $ifNull: [`$${field}`, false] }, 1, 0] } };
}

export const MESSAGE_STATS_GROUP = {
	sent: countIf("sentAt"),
	delivered: countIf("deliveredAt"),
	opened: countIf("openedAt"),
	clicked: countIf("clickedAt"),
	bounced: countIf("bouncedAt"),
	complained: countIf("complainedAt"),
};
