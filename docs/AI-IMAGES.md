# AI images

In the rich editor, choose an image and open **Generate image**. Describe one image, explicitly agree to Cloudflare processing and public storage, generate, then review it and add alt text before inserting. Closing the picker leaves the image in the media library. Generation never sends, schedules or publishes a campaign. Servers without Workers AI hide the editor option and refuse the action.

`generate_image` (`POST /api/v1/ai/images`, also MCP) accepts a newsletter, a description of up to 2,048 characters, `consent: true` and an optional media folder. It is a write-draft action, uses the normal account, team, agent newsletter and daily-cap guards, and has a shared account limit of ten attempts an hour. Draft agents can generate; read-only and signups keys cannot.

The server uses Cloudflare-hosted `@cf/black-forest-labs/flux-1-schnell`, four steps, through the existing AI Gateway with logging and caching off. No other provider or SDK is used. The prompt alone goes to the model; no newsletter brief, contact record or campaign content is added. FlockStack does not keep or log it, including when it resembles an ID. Do not put private information in a description. Processing can occur outside the account's region.

Each started generation takes one request from the existing daily AI allowance shared with the writing tools. Provider errors, unusable output and storage failures still count. Missing consent, invalid input, unavailable AI or invalid storage configuration fail before the count is taken. Concurrent calls cannot both take the last daily request. A failure does not promise a refund of the operator's provider charge. There is no automatic retry or fallback image model.

The server accepts bounded canonical base64 JPEG data, checks its signature, frame dimensions, scan header and end marker, and rejects missing, oversized or unsupported output. It never fetches a URL returned by a model. This is a structural check, not a full JPEG decoder. The browser displays a preview before insertion.

The image uses the same public, permanent storage and account-derived path as other uploads, with a fixed generated filename unrelated to the description. Upload records contain the model and generation date, never the prompt. The image library labels these images. `generated-images.csv` in a private account export includes the owned records; used assets follow the ordinary export path. Account purge removes their records and objects like other uploads. A failed upload-record write attempts to remove the stored object; storage outages can still prevent cleanup.

Self-hosting needs the existing Workers AI binding and an image store. `AI_DAILY_LIMIT` controls the existing self-hosted daily allowance; without it that allowance is unlimited, while the ten-an-hour action limit remains. Review model availability and the operator's applicable provider/model terms before enabling generation. No live generation is run by the test suite.

References: [Cloudflare's FLUX.1 schnell API](https://developers.cloudflare.com/workers-ai/models/flux-1-schnell/), [model terms linked by Cloudflare](https://bfl.ai/legal/terms-of-service). These references describe the provider; local synthetic tests do not establish live availability, output quality, licence clearance or billing behavior.
