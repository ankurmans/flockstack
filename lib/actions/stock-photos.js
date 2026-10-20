import "server-only";
import * as z from "zod";
import { defineAction } from "@/lib/actions/define-action";
import { actionError } from "@/lib/actions/errors";
import { getCreditHtml, getImageHtml, getUnsplashKey, isPhotoId, searchPhotos, takeUnsplashPhoto, withUtm } from "@/lib/unsplash";

const GROUP = "Media library";
const ATTRIBUTION = "Photos are hotlinked from Unsplash and must be credited to their photographer and to Unsplash: use_stock_photo returns the credit.";

const PhotoSchema = z.object({
	id: z.string(),
	description: z.string(),
	width: z.number().int(),
	height: z.number().int(),
	thumbUrl: z.string().describe("A small version, for choosing"),
	url: z.string().describe("The photo to use, 1080 pixels wide, hosted by Unsplash"),
	pageUrl: z.string().describe("The photo's page on Unsplash"),
	photographer: z.object({ name: z.string(), url: z.string() }),
});

function readFailure(error) {
	if (error === "not_found") throw actionError("not_found", "That photo isn't on Unsplash");
	if (error === "rate_limited") throw actionError("rate_limited", "Unsplash asked for a pause: try again in a while");
	throw actionError("unavailable", "Unsplash didn't answer. Try again in a minute.");
}

function requireKey() {
	const key = getUnsplashKey();
	if (!key) throw actionError("unavailable", "Stock photos aren't set up on this server (UNSPLASH_ACCESS_KEY)");
	return key;
}

const searchStockPhotos = defineAction({
	name: "search_stock_photos",
	tryWithoutPlan: true,
	title: "Search stock photos",
	group: GROUP,
	description: `Searches Unsplash's free stock photos. Only the search words leave FlockStack. ${ATTRIBUTION} Not available on a server without an Unsplash key.`,
	http: { method: "GET", path: "/stock-photos" },
	readOnly: true,
	openWorld: true,
	rateLimit: { limit: 120, window: "1 h" },
	example: { query: "mountain lake" },
	input: z.object({
		query: z.string().trim().min(1).max(100).describe("What to look for"),
		page: z.number().int().min(1).max(50).optional().describe("The page of results, from 1"),
		perPage: z.number().int().min(1).max(30).optional().describe("Photos a page, 24 by default, 30 at most"),
	}),
	output: z.object({
		photos: z.array(PhotoSchema),
		total: z.number().int(),
		totalPages: z.number().int(),
		unsplashUrl: z.string().describe("Unsplash's address, with the utm parameters its guidelines ask for, to link wherever the photos are shown"),
	}),
	handler: async ({ input }) => {
		const key = requireKey();
		const result = await searchPhotos({ query: input.query, page: input.page, perPage: input.perPage ?? 24, key });
		if (result.error) readFailure(result.error);
		return { photos: result.photos.map(({ color, ...photo }) => photo), total: result.total, totalPages: result.totalPages, unsplashUrl: withUtm("https://unsplash.com/") };
	},
});

const chooseStockPhoto = defineAction({
	name: "use_stock_photo",
	tryWithoutPlan: true,
	title: "Use a stock photo",
	group: GROUP,
	description: `Picks a stock photo from search_stock_photos for an issue: tells Unsplash it is used, as its API rules require, and returns the HTML to put in a rich campaign's content, the photo and its credit line. ${ATTRIBUTION}`,
	http: { method: "POST", path: "/stock-photos/use" },
	openWorld: true,
	rateLimit: { limit: 60, window: "1 h" },
	example: { id: "Dwu85P9SOIk" },
	input: z.object({ id: z.string().trim().min(1).max(30).describe("The photo's ID from search_stock_photos") }),
	output: PhotoSchema.omit({ thumbUrl: true }).extend({
		html: z.string().describe("The image block, then its credit line, for a rich campaign's content"),
		imageHtml: z.string().describe("The image alone"),
		creditHtml: z.string().describe("The credit line alone: keep it with the photo"),
		unsplashUrl: z.string().describe("Unsplash's address, with its utm parameters"),
	}),
	handler: async ({ input }) => {
		const key = requireKey();
		if (!isPhotoId(input.id)) throw actionError("validation_failed", "id: use a photo's ID from search_stock_photos");
		const result = await takeUnsplashPhoto({ id: input.id, key });
		if (result.error) readFailure(result.error);
		const { photo } = result;
		const { thumbUrl, color, ...rest } = photo;
		const imageHtml = getImageHtml(photo);
		const creditHtml = getCreditHtml(photo);
		return { ...rest, html: `${imageHtml}${creditHtml}`, imageHtml, creditHtml, unsplashUrl: withUtm("https://unsplash.com/") };
	},
});

export const stockPhotoActions = [searchStockPhotos, chooseStockPhoto];
