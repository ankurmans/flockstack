import { defineCloudflareConfig } from "@opennextjs/cloudflare";

// No incremental cache bucket yet: archive pages render on request (they're small, and D1 answers fast).
// buildCommand: the build, then scripts/dedupe-chunks.mjs, which makes the copies of one chunk that Turbopack writes load the first
// instead of repeating it (a third of the Worker's script was that), then scripts/short-chunk-names.mjs, which gives every server chunk a
// name of a few characters (its long name, written wherever the chunk is loaded, was a tenth of the handler).
export default {
	...defineCloudflareConfig(),
	buildCommand: "npm run build && node scripts/dedupe-chunks.mjs && node scripts/short-chunk-names.mjs",
};
