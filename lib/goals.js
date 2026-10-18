// A step in the product worth counting (a campaign sent), reported from client code on the window, the way lib/sign-out.js
// reports a sign-out. FlockStack Cloud's analytics listens (components/marketing/ProviderAnalytics.jsx); anywhere else
// nothing does, so reporting one costs nothing and the open source needs no analytics code.
export const GOAL_EVENT = "flockstack:goal";

export function reportGoal(goal, props = {}) {
	if (typeof window === "undefined") return;
	window.dispatchEvent(new CustomEvent(GOAL_EVENT, { detail: { goal, props } }));
}
