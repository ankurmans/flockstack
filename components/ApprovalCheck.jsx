"use client";

import PanelReady from "@/components/PanelReady";
import { useReadyCheck } from "@/lib/use-ready-check";

const KEEP = async () => true;

// The ready-to-send check (lib/ready-check.js) under an agent's request to send or schedule a campaign, so the owner approves
// with what a writer would see in the review step: it opens the campaign as it is now, links included.
export default function ApprovalCheck({ campaignId }) {
	const ready = useReadyCheck({ campaignId, isActive: true, persist: KEEP, key: "" });
	return <PanelReady ready={ready} isApproval />;
}
