import { defineCloudflareConfig } from "@opennextjs/cloudflare";

// No incremental cache bucket yet: archive pages render on request (they're small, and D1 answers fast).
export default defineCloudflareConfig();
