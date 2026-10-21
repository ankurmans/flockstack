import { defineCloudflareConfig } from "@opennextjs/cloudflare";

// No incremental cache bucket yet: archive pages render on request (they're small, and D1 answers fast).
// buildCommand: the build, then scripts/dedupe-chunks.mjs, which makes the copies of one chunk that Turbopack writes load the first
// instead of repeating it (a third of the Worker's script was that).
export default {
	...defineCloudflareConfig(),
	buildCommand: "npm run build && node scripts/dedupe-chunks.mjs",
};
