import "server-only";
import * as z from "zod";
import { scoped } from "@/lib/account-scope";
import { defineAction } from "@/lib/actions/define-action";
import { actionError } from "@/lib/actions/errors";
import { afterCursor, dateOutput, encodeCursor, findNewsletter, idInput, newsletterFilterInput, newsletterInput, toIso } from "@/lib/actions/shared";
import { CURRENCIES, MAX_PRICE_CENTS, MIN_PRICE_CENTS } from "@/lib/payments/config";
import { assertPaymentsReady } from "@/lib/payments/connect";
import { resendDownloadEmail } from "@/lib/payments/orders";
import { deletePrivateFiles, makeProductFileKey, putPrivateFile, safeFileName } from "@/lib/private-files";
import { MAX_PRODUCT_FILE_BYTES, PRODUCT_SLUG_PATTERN, getProductProblem, getProductUrl, revalidateShop, uniqueProductSlug } from "@/lib/products";
import { isObjectIdString } from "@/lib/validation";
import Newsletter from "@/models/Newsletter";
import Order, { ORDER_EMAIL_STATUSES, ORDER_STATUSES } from "@/models/Order";
import Product, { PRODUCT_STATUSES } from "@/models/Product";

const GROUP = "Products";
const ORDERS_GROUP = "Orders";
const PAID_NOTE = "FlockStack takes no cut: the buyer pays your Stripe account, and only Stripe's own processing fee comes off.";
// base64 grows a file by a third.
const MAX_BASE64_LENGTH = Math.ceil(MAX_PRODUCT_FILE_BYTES / 3) * 4 + 100;

const productId = idInput("product");
const orderId = idInput("order");
const titleInput = z.string().trim().min(1).max(120).describe("The product's name, shown on its page and in Stripe's checkout, 120 characters at most");
const descriptionInput = z.string().trim().max(2000).describe("What the buyer gets, 2,000 characters at most");
const priceInput = z
	.number()
	.int()
	.min(MIN_PRICE_CENTS)
	.max(MAX_PRICE_CENTS)
	.describe(`The price in the currency's smallest unit, e.g. 1900 for $19.00 (at least ${MIN_PRICE_CENTS})`);
const currencyInput = z.enum(CURRENCIES).describe(`The currency: ${CURRENCIES.join(", ")}`);
const slugInput = z
	.string()
	.trim()
	.toLowerCase()
	.regex(PRODUCT_SLUG_PATTERN, "Use lowercase letters, digits and dashes, 80 at most")
	.describe("The product page's path on the newsletter's site: /shop/<slug>. Default: made from the title.");
const imageInput = z.string().trim().max(500).describe("A cover image: an https:// link, e.g. from upload_image. Empty removes it.");

const ProductSchema = z.object({
	id: z.string(),
	newsletterId: z.string(),
	title: z.string(),
	slug: z.string(),
	description: z.string(),
	priceCents: z.number().int(),
	currency: z.string(),
	status: z.enum(PRODUCT_STATUSES).describe("draft: being set up. active: for sale. archived: off sale; earlier buyers keep their downloads."),
	imageUrl: z.string().nullable(),
	file: z.object({ name: z.string(), contentType: z.string(), bytes: z.number().int(), uploadedAt: dateOutput }).nullable().describe("The file buyers get, null until set_product_file runs"),
	url: z.string().nullable().describe("The product's public page, once it is active and the newsletter's archive is on"),
	sales: z.number().int().describe("Paid orders, refunded ones left out"),
	revenueCents: z.number().int().describe("What those orders paid, partial refunds taken off"),
	createdAt: dateOutput,
	updatedAt: dateOutput,
});
const OrderSchema = z.object({
	id: z.string(),
	productId: z.string(),
	productTitle: z.string(),
	newsletterId: z.string(),
	buyerEmail: z.string(),
	buyerName: z.string().nullable(),
	amountCents: z.number().int(),
	currency: z.string(),
	amountRefundedCents: z.number().int(),
	status: z.enum(ORDER_STATUSES).describe("paid, refunded (in full, in Stripe) or disputed (a chargeback). The download link only works while it is paid."),
	paidAt: dateOutput,
	emailStatus: z.enum(ORDER_EMAIL_STATUSES).describe("The email with the download link: sent, or suppressed (the address bounced before) or failed"),
	emailSentAt: dateOutput,
	emailError: z.string().nullable(),
	downloads: z.number().int(),
	joinedList: z.boolean().describe("The buyer ticked the box to join the newsletter's list at checkout"),
});

export function toProduct(product, newsletter, stats) {
	return {
		id: String(product._id),
		newsletterId: String(product.newsletterId),
		title: product.title,
		slug: product.slug,
		description: product.description ?? "",
		priceCents: product.priceCents,
		currency: product.currency,
		status: product.status,
		imageUrl: product.imageUrl ?? null,
		file: product.file?.key
			? { name: product.file.name, contentType: product.file.contentType, bytes: product.file.bytes, uploadedAt: toIso(product.file.uploadedAt) }
			: null,
		url: newsletter ? getProductUrl({ newsletter, product }) : null,
		sales: stats?.sales ?? 0,
		revenueCents: stats?.revenueCents ?? 0,
		createdAt: toIso(product.createdAt),
		updatedAt: toIso(product.updatedAt),
	};
}

function toOrder(order) {
	return {
		id: String(order._id),
		productId: String(order.productId),
		productTitle: order.productTitle,
		newsletterId: String(order.newsletterId),
		buyerEmail: order.buyerEmail,
		buyerName: order.buyerName ?? null,
		amountCents: order.amountCents,
		currency: order.currency,
		amountRefundedCents: order.amountRefundedCents ?? 0,
		status: order.status,
		paidAt: toIso(order.paidAt),
		emailStatus: order.emailStatus ?? "pending",
		emailSentAt: toIso(order.emailSentAt),
		emailError: order.emailError ?? null,
		downloads: order.downloadCount ?? 0,
		joinedList: Boolean(order.listConsent?.at),
	};
}

async function findProduct(account, id) {
	const product = isObjectIdString(id) ? await Product.findOne(scoped(account, { _id: id })).lean() : null;
	if (!product) throw actionError("not_found", "Product not found");
	return product;
}

async function findOrder(account, id) {
	const order = isObjectIdString(id) ? await Order.findOne(scoped(account, { _id: id })).lean() : null;
	if (!order) throw actionError("not_found", "Order not found");
	return order;
}

async function getSalesStats(account, productIds) {
	if (productIds.length === 0) return new Map();
	const rows = await Order.aggregate([
		{ $match: scoped(account, { productId: { $in: productIds }, status: "paid" }) },
		{ $group: { _id: "$productId", sales: { $sum: 1 }, revenueCents: { $sum: { $subtract: ["$amountCents", { $ifNull: ["$amountRefundedCents", 0] }] } } } },
	]);
	return new Map(rows.map(({ _id, sales, revenueCents }) => [String(_id), { sales, revenueCents }]));
}

async function toProductDetail(account, product) {
	const [newsletter, stats] = await Promise.all([
		Newsletter.findOne(scoped(account, { _id: product.newsletterId })).lean(),
		getSalesStats(account, [product._id]),
	]);
	return toProduct(product, newsletter, stats.get(String(product._id)));
}

async function reload(account, id) {
	return toProductDetail(account, await Product.findOne(scoped(account, { _id: id })).lean());
}

function decodeFile(base64) {
	const data = String(base64 ?? "").replace(/^data:[^,]*;base64,/i, "").replace(/\s+/g, "");
	if (!data || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(data)) return null;
	return new Uint8Array(Buffer.from(data, "base64"));
}

const createProduct = defineAction({
	name: "create_product",
	title: "Create a product",
	group: GROUP,
	description: `Creates a digital product for one of the newsletter's readers to buy, as a draft: upload its file with set_product_file, then publish it with update_product (status active). It then has a page at /shop/<slug> on the newsletter's site, and buyers pay through Stripe Checkout and get a download link by email. ${PAID_NOTE}`,
	http: { method: "POST", path: "/products", status: 201 },
	rateLimit: { limit: 60, window: "1 h" },
	example: { title: "Launch checklist", description: "A 12-page PDF of everything to do before you send your first issue.", priceCents: 1900 },
	input: z.object({
		newsletter: newsletterInput,
		title: titleInput,
		description: descriptionInput.optional(),
		priceCents: priceInput,
		currency: currencyInput.optional().describe("Default: usd"),
		slug: slugInput.optional(),
		imageUrl: imageInput.optional(),
	}),
	output: ProductSchema,
	handler: async ({ account, input }) => {
		const newsletter = await findNewsletter(account, input.newsletter);
		let slug = input.slug;
		if (!slug) slug = await uniqueProductSlug({ accountId: account._id, newsletterId: newsletter._id, base: input.title });
		else if (await Product.exists({ accountId: account._id, newsletterId: newsletter._id, slug })) {
			throw actionError("conflict", "Another product of this newsletter uses this slug");
		}
		const product = await Product.create({
			accountId: account._id,
			newsletterId: newsletter._id,
			title: input.title,
			slug,
			description: input.description ?? "",
			priceCents: input.priceCents,
			currency: input.currency ?? "usd",
			...(input.imageUrl && { imageUrl: input.imageUrl }),
		});
		return toProduct(product.toObject(), newsletter);
	},
});

const updateProduct = defineAction({
	name: "update_product",
	title: "Update a product",
	group: GROUP,
	description: `Changes a product's title, description, price, currency, slug or cover image, or puts it on sale (status active) or takes it back to a draft. Send only the fields to change. A price change applies to the next sale; earlier orders keep what they paid. Putting a product on sale needs its file and a Stripe account that can take payments (get_payments_status). ${PAID_NOTE}`,
	http: { method: "PATCH", path: "/products/{id}" },
	idempotent: true,
	example: { priceCents: 2400, status: "active" },
	input: z.object({
		id: productId,
		title: titleInput.optional(),
		description: descriptionInput.optional(),
		priceCents: priceInput.optional(),
		currency: currencyInput.optional(),
		slug: slugInput.optional(),
		imageUrl: imageInput.optional(),
		status: z.enum(["draft", "active"]).optional().describe("active puts it on sale; draft takes it off sale without archiving it. Use archive_product to retire it."),
	}),
	output: ProductSchema,
	handler: async ({ account, input }) => {
		const product = await findProduct(account, input.id);
		if (product.status === "archived" && input.status !== "draft") throw actionError("conflict", "This product is archived: set its status to draft to bring it back");
		const set = {
			...(input.title !== undefined && { title: input.title }),
			...(input.description !== undefined && { description: input.description }),
			...(input.priceCents !== undefined && { priceCents: input.priceCents }),
			...(input.currency !== undefined && { currency: input.currency }),
			...(input.status !== undefined && { status: input.status }),
		};
		const unset = {};
		if (input.status === "draft") unset.archivedAt = 1;
		if (input.imageUrl !== undefined) {
			if (input.imageUrl) set.imageUrl = input.imageUrl;
			else unset.imageUrl = 1;
		}
		if (input.slug !== undefined && input.slug !== product.slug) {
			if (await Product.exists({ accountId: account._id, newsletterId: product.newsletterId, slug: input.slug, _id: { $ne: product._id } })) {
				throw actionError("conflict", "Another product of this newsletter uses this slug");
			}
			set.slug = input.slug;
		}
		if (input.status === "active" && product.status !== "active") {
			const problem = getProductProblem({ ...product, ...set });
			if (problem) throw actionError("validation_failed", `status: ${problem} first`);
			assertPaymentsReady(account);
		}
		if (Object.keys(set).length > 0 || Object.keys(unset).length > 0) {
			try {
				await Product.updateOne(scoped(account, { _id: product._id }), {
					...(Object.keys(set).length > 0 && { $set: set }),
					...(Object.keys(unset).length > 0 && { $unset: unset }),
				});
			} catch (error) {
				if (error?.code === 11000) throw actionError("conflict", "Another product of this newsletter uses this slug");
				throw error;
			}
			revalidateShop();
		}
		return reload(account, product._id);
	},
});

const listProducts = defineAction({
	name: "list_products",
	title: "List products",
	group: GROUP,
	description: "Lists the account's digital products, newest first, with how many each sold and what it earned.",
	http: { method: "GET", path: "/products" },
	readOnly: true,
	example: { status: "active" },
	input: z.object({
		newsletter: newsletterFilterInput,
		status: z.enum(PRODUCT_STATUSES).optional().describe("Only products with this status"),
	}),
	output: z.object({ products: z.array(ProductSchema) }),
	handler: async ({ account, input }) => {
		const newsletter = input.newsletter ? await findNewsletter(account, input.newsletter, { _id: 1 }) : null;
		const filter = scoped(account, { ...(newsletter && { newsletterId: newsletter._id }), ...(input.status && { status: input.status }) });
		const [products, newsletters] = await Promise.all([
			Product.find(filter).sort({ createdAt: -1, _id: -1 }).limit(200).lean(),
			Newsletter.find(scoped(account)).select({ slug: 1, archiveEnabled: 1, archiveHost: 1 }).lean(),
		]);
		const stats = await getSalesStats(account, products.map(({ _id }) => _id));
		const byId = new Map(newsletters.map((item) => [String(item._id), item]));
		return { products: products.map((product) => toProduct(product, byId.get(String(product.newsletterId)), stats.get(String(product._id)))) };
	},
});

const getProduct = defineAction({
	name: "get_product",
	title: "Get a product",
	group: GROUP,
	description: "Gets one product with its file, its public page and what it sold.",
	http: { method: "GET", path: "/products/{id}" },
	readOnly: true,
	input: z.object({ id: productId }),
	output: ProductSchema,
	handler: async ({ account, input }) => toProductDetail(account, await findProduct(account, input.id)),
});

const archiveProduct = defineAction({
	name: "archive_product",
	title: "Archive a product",
	group: GROUP,
	description: "Takes a product off sale and off the shop. Its earlier buyers keep their download links, and its orders stay. update_product with status draft brings it back.",
	http: { method: "POST", path: "/products/{id}/archive" },
	idempotent: true,
	whileBlocked: true,
	input: z.object({ id: productId }),
	output: ProductSchema,
	handler: async ({ account, input }) => {
		const product = await findProduct(account, input.id);
		if (product.status !== "archived") {
			await Product.updateOne(scoped(account, { _id: product._id }), { $set: { status: "archived", archivedAt: new Date() } });
			revalidateShop();
		}
		return reload(account, product._id);
	},
});

const setProductFile = defineAction({
	name: "set_product_file",
	title: "Upload a product's file",
	group: GROUP,
	description: `Stores the file buyers download, up to ${MAX_PRODUCT_FILE_BYTES / 1024 / 1024} MB, sent as base64. It is kept in a private bucket and only ever served through a signed link that expires, never from a public URL. Replacing it changes what every buyer downloads from then on.`,
	http: { method: "POST", path: "/products/{id}/file" },
	openWorld: true,
	rateLimit: { limit: 30, window: "1 h" },
	input: z.object({
		id: productId,
		base64: z.string().max(MAX_BASE64_LENGTH).describe("The file, base64 encoded; a data: URL works too"),
		fileName: z.string().trim().min(1).max(200).describe("The name buyers download it as, e.g. launch-checklist.pdf"),
		contentType: z.string().trim().max(100).optional().describe("The file's type, e.g. application/pdf. Default: application/octet-stream."),
	}),
	output: ProductSchema,
	handler: async ({ account, input }) => {
		const product = await findProduct(account, input.id);
		const bytes = decodeFile(input.base64);
		if (!bytes || bytes.length === 0) throw actionError("validation_failed", "base64: isn't valid base64");
		if (bytes.length > MAX_PRODUCT_FILE_BYTES) throw actionError("validation_failed", `The file is over ${MAX_PRODUCT_FILE_BYTES / 1024 / 1024} MB`);
		const name = safeFileName(input.fileName);
		const key = makeProductFileKey({ accountId: account._id, productId: product._id, fileName: name });
		const contentType = /^[\w.+-]+\/[\w.+-]+$/.test(input.contentType ?? "") ? input.contentType : "application/octet-stream";
		try {
			await putPrivateFile(key, bytes, contentType);
		} catch (error) {
			console.error("[products] File upload failed:", error);
			throw actionError("unavailable", "The upload failed, try again");
		}
		try {
			await Product.updateOne(scoped(account, { _id: product._id }), {
				$set: { file: { key, name, contentType, bytes: bytes.length, uploadedAt: new Date() } },
			});
		} catch (error) {
			await deletePrivateFiles([key]).catch((deleteError) => console.error(`[products] ${key} stays without a record:`, deleteError));
			throw error;
		}
		if (product.file?.key) await deletePrivateFiles([product.file.key]).catch((error) => console.error(`[products] The old file ${product.file.key} stays:`, error));
		return reload(account, product._id);
	},
});

const listOrders = defineAction({
	name: "list_orders",
	title: "List orders",
	group: ORDERS_GROUP,
	description: "Lists the orders of the account's products, newest first, 50 a page: who bought, what they paid, whether the download email went out, and refunds. Pass nextCursor back as cursor for the next page.",
	http: { method: "GET", path: "/orders" },
	readOnly: true,
	example: { status: "paid", limit: 20 },
	input: z.object({
		product: z.string().trim().max(100).optional().describe("Only this product's orders: its ID"),
		status: z.enum(ORDER_STATUSES).optional().describe("Only orders with this status"),
		limit: z.number().int().min(1).max(100).optional().describe("Orders per page, 50 by default, 100 at most"),
		cursor: z.string().max(200).optional().describe("nextCursor from the previous page"),
	}),
	output: z.object({ orders: z.array(OrderSchema), nextCursor: z.string().nullable().describe("null on the last page") }),
	handler: async ({ account, input }) => {
		if (input.product && !isObjectIdString(input.product)) throw actionError("validation_failed", "product: use a product's ID");
		const limit = input.limit ?? 50;
		const filter = scoped(account, {
			...(input.product && { productId: input.product }),
			...(input.status && { status: input.status }),
			...(input.cursor && afterCursor(input.cursor, "createdAt")),
		});
		const orders = await Order.find(filter).sort({ createdAt: -1, _id: -1 }).limit(limit + 1).lean();
		const page = orders.slice(0, limit);
		const last = page.at(-1);
		return { orders: page.map(toOrder), nextCursor: orders.length > limit ? encodeCursor(last.createdAt, last._id) : null };
	},
});

const getOrder = defineAction({
	name: "get_order",
	title: "Get an order",
	group: ORDERS_GROUP,
	description: "Gets one order: the buyer, the amount, refunds, how many times the file was downloaded and whether the download email went out.",
	http: { method: "GET", path: "/orders/{id}" },
	readOnly: true,
	input: z.object({ id: orderId }),
	output: OrderSchema,
	handler: async ({ account, input }) => toOrder(await findOrder(account, input.id)),
});

const resendOrderEmail = defineAction({
	name: "resend_order_email",
	title: "Resend an order's download link",
	group: ORDERS_GROUP,
	description: "Emails the buyer a new download link, valid for 7 days. The earlier link stops working. Refunded and disputed orders can't be resent. Refunds are made in your Stripe dashboard.",
	http: { method: "POST", path: "/orders/{id}/resend" },
	openWorld: true,
	rateLimit: { limit: 30, window: "1 h" },
	input: z.object({ id: orderId }),
	output: OrderSchema,
	handler: async ({ account, input }) => {
		const order = await findOrder(account, input.id);
		if (order.status !== "paid") throw actionError("conflict", `This order was ${order.status === "refunded" ? "refunded" : "disputed"}: there is nothing to resend`);
		const result = await resendDownloadEmail({ account, order });
		if (!result.sent) throw actionError("unavailable", `The email wasn't sent: ${result.reason ?? "try again"}`);
		return toOrder(await findOrder(account, input.id));
	},
});

export const productActions = [createProduct, updateProduct, listProducts, getProduct, archiveProduct, setProductFile, listOrders, getOrder, resendOrderEmail];
