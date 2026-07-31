import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { type MutationCtx, mutation, query } from "./_generated/server";
import {
	getViewerUserId,
	requireBookOwner,
	requireViewerUserId,
} from "./authHelpers";
import {
	cleanDeviceId,
	nextServerVersion,
	observedServerVersion,
	rejectsStaleBase,
} from "./syncVersion";

const HISTORY_LIMIT = 50;
const SAME_CHAPTER_CHECKPOINT_FRACTION = 0.1;
const SAME_CHAPTER_CHECKPOINT_INTERVAL_MS = 10 * 60 * 1000;

const deviceKindValidator = v.union(
	v.literal("phone"),
	v.literal("tablet"),
	v.literal("computer"),
	v.literal("unknown"),
);

type DeviceKind = "phone" | "tablet" | "computer" | "unknown";
type ProgressPoint = {
	sectionIndex: number;
	blockIndex: number;
	blockOffset: number;
	sectionFraction: number;
};

const samePoint = (a: ProgressPoint, b: ProgressPoint) =>
	a.sectionIndex === b.sectionIndex &&
	a.blockIndex === b.blockIndex &&
	a.blockOffset === b.blockOffset &&
	a.sectionFraction === b.sectionFraction;

const pointFromUserBook = (
	entry: {
		lastSectionIndex?: number;
		lastBlockIndex?: number;
		lastBlockOffset?: number;
		lastSectionFraction?: number;
	},
	sectionCount?: number,
): ProgressPoint => {
	const index = (value: number | undefined) =>
		Number.isFinite(value) ? Math.max(0, Math.floor(value ?? 0)) : 0;
	const fraction = (value: number | undefined) =>
		Number.isFinite(value) ? Math.min(1, Math.max(0, value ?? 0)) : 0;
	const sectionIndex = index(entry.lastSectionIndex);
	return {
		sectionIndex:
			sectionCount !== undefined && sectionCount > 0
				? Math.min(sectionIndex, sectionCount - 1)
				: sectionIndex,
		blockIndex: index(entry.lastBlockIndex),
		blockOffset: fraction(entry.lastBlockOffset),
		sectionFraction: fraction(entry.lastSectionFraction),
	};
};

async function preserveProgressCheckpoint(
	ctx: MutationCtx,
	args: {
		userId: Id<"users">;
		bookId: Id<"books">;
		point: ProgressPoint;
		progressServerTime: number;
		recordedAt: number;
		deviceId?: string;
		deviceKind?: DeviceKind;
		cause: "reading" | "restore";
		largeBackwardJump?: boolean;
		nextPoint?: ProgressPoint;
		force?: boolean;
	},
) {
	if (args.progressServerTime <= 0) {
		return null;
	}
	const latest = await ctx.db
		.query("progressHistory")
		.withIndex("by_user_book_recorded", (q) =>
			q.eq("userId", args.userId).eq("bookId", args.bookId),
		)
		.order("desc")
		.first();
	if (
		latest &&
		samePoint(args.point, {
			sectionIndex: latest.sectionIndex,
			blockIndex: latest.blockIndex ?? 0,
			blockOffset: latest.blockOffset ?? 0,
			sectionFraction: latest.sectionFraction ?? 0,
		})
	) {
		return latest._id;
	}

	if (!args.force) {
		const changedChapter =
			args.nextPoint !== undefined &&
			args.nextPoint.sectionIndex !== args.point.sectionIndex;
		if (!changedChapter) {
			const lastFraction =
				latest?.sectionIndex === args.point.sectionIndex
					? (latest.sectionFraction ?? 0)
					: 0;
			const farEnough =
				Math.abs(args.point.sectionFraction - lastFraction) >=
				SAME_CHAPTER_CHECKPOINT_FRACTION;
			const oldEnough =
				args.recordedAt - (latest?.recordedAt ?? args.progressServerTime) >=
				SAME_CHAPTER_CHECKPOINT_INTERVAL_MS;
			if (!farEnough && !oldEnough) {
				return null;
			}
		}
	}

	const id = await ctx.db.insert("progressHistory", {
		userId: args.userId,
		bookId: args.bookId,
		sectionIndex: args.point.sectionIndex,
		blockIndex: args.point.blockIndex,
		blockOffset: args.point.blockOffset,
		sectionFraction: args.point.sectionFraction,
		progressServerTime: args.progressServerTime,
		recordedAt: args.recordedAt,
		deviceId: cleanDeviceId(args.deviceId),
		deviceKind: args.deviceKind,
		cause: args.cause,
		largeBackwardJump: args.largeBackwardJump || undefined,
	});
	const retained = await ctx.db
		.query("progressHistory")
		.withIndex("by_user_book_recorded", (q) =>
			q.eq("userId", args.userId).eq("bookId", args.bookId),
		)
		.order("desc")
		.take(HISTORY_LIMIT + 1);
	for (const old of retained.slice(HISTORY_LIMIT)) {
		await ctx.db.delete(old._id);
	}
	return id;
}

export const upsertUserBook = mutation({
	args: {
		bookId: v.id("books"),
	},
	handler: async (ctx, args) => {
		const userId = await requireViewerUserId(ctx);
		await requireBookOwner(ctx, args.bookId);
		const existing = await ctx.db
			.query("userBooks")
			.withIndex("by_user_book", (q) =>
				q.eq("userId", userId).eq("bookId", args.bookId),
			)
			.first();

		const now = nextServerVersion(existing?.updatedAt ?? 0);
		if (existing) {
			// Opening a book is reading activity → bump Recent recency.
			await ctx.db.patch(existing._id, {
				updatedAt: now,
				lastActivityAt: now,
			});
			return existing._id;
		}

		return await ctx.db.insert("userBooks", {
			userId,
			bookId: args.bookId,
			lastSectionIndex: 0,
			updatedAt: now,
			lastActivityAt: now,
		});
	},
});

export const getUserBook = query({
	args: {
		bookId: v.id("books"),
	},
	handler: async (ctx, args) => {
		const userId = await getViewerUserId(ctx);
		if (!userId) {
			return null;
		}
		// Graceful when the book was deleted (possibly from another device) —
		// a live reader subscription must not explode into an error page.
		const book = await ctx.db.get(args.bookId);
		if (!book || book.ownerId !== userId) {
			return null;
		}
		return await ctx.db
			.query("userBooks")
			.withIndex("by_user_book", (q) =>
				q.eq("userId", userId).eq("bookId", args.bookId),
			)
			.first();
	},
});

export const updateProgress = mutation({
	args: {
		bookId: v.id("books"),
		lastSectionIndex: v.optional(v.number()),
		lastBlockIndex: v.optional(v.number()),
		lastBlockOffset: v.optional(v.number()),
		lastSectionFraction: v.optional(v.number()),
		// Last server version this device actually merged before editing.
		baseServerTime: v.optional(v.number()),
		deviceId: v.optional(v.string()),
		deviceKind: v.optional(deviceKindValidator),
	},
	handler: async (ctx, args) => {
		const userId = await requireViewerUserId(ctx);
		const { book } = await requireBookOwner(ctx, args.bookId);
		const existing = await ctx.db
			.query("userBooks")
			.withIndex("by_user_book", (q) =>
				q.eq("userId", userId).eq("bookId", args.bookId),
			)
			.first();

		const currentServerTime =
			existing?.progressUpdatedAt ??
			(existing?.progressEditedAt !== undefined ? existing.updatedAt : 0);
		// Optimistic concurrency: a stale offline write must not overwrite a
		// server value it never observed — unless this same device authored the
		// current value, in which case the "stale" base is just this device's
		// own lost acknowledgement (see rejectsStaleBase). Wall clocks are
		// irrelevant either way.
		if (
			existing &&
			rejectsStaleBase({
				baseServerTime: args.baseServerTime,
				currentServerTime,
				currentWriterDeviceId: existing.progressDeviceId,
				requestDeviceId: cleanDeviceId(args.deviceId),
			})
		) {
			return {
				id: existing._id,
				accepted: false,
				serverTime: currentServerTime,
				lastSectionIndex: existing.lastSectionIndex ?? 0,
				lastBlockIndex: existing.lastBlockIndex,
				lastBlockOffset: existing.lastBlockOffset,
				lastSectionFraction: existing.lastSectionFraction,
			};
		}
		const requestedPoint = pointFromUserBook(
			{
				lastSectionIndex:
					args.lastSectionIndex ?? existing?.lastSectionIndex ?? 0,
				lastBlockIndex: args.lastBlockIndex ?? existing?.lastBlockIndex ?? 0,
				lastBlockOffset: args.lastBlockOffset ?? existing?.lastBlockOffset ?? 0,
				lastSectionFraction:
					args.lastSectionFraction ?? existing?.lastSectionFraction ?? 0,
			},
			book.sectionCount,
		);
		if (existing && currentServerTime > 0) {
			const currentPoint = pointFromUserBook(existing, book.sectionCount);
			if (samePoint(currentPoint, requestedPoint)) {
				return {
					id: existing._id,
					accepted: true,
					serverTime: currentServerTime,
					lastSectionIndex: currentPoint.sectionIndex,
					lastBlockIndex: currentPoint.blockIndex,
					lastBlockOffset: currentPoint.blockOffset,
					lastSectionFraction: currentPoint.sectionFraction,
				};
			}
		}

		const now = nextServerVersion(
			Math.max(currentServerTime, existing?.updatedAt ?? 0),
		);
		const patch = {
			lastSectionIndex: requestedPoint.sectionIndex,
			lastBlockIndex: requestedPoint.blockIndex,
			lastBlockOffset: requestedPoint.blockOffset,
			lastSectionFraction: requestedPoint.sectionFraction,
			updatedAt: now,
			// Reading is activity → drives Recent recency.
			lastActivityAt: now,
			progressUpdatedAt: now,
			progressDeviceId: cleanDeviceId(args.deviceId),
			progressDeviceKind: args.deviceKind,
		};

		if (existing) {
			const previousPoint = pointFromUserBook(existing, book.sectionCount);
			const nextPoint = requestedPoint;
			if (!samePoint(previousPoint, nextPoint)) {
				await preserveProgressCheckpoint(ctx, {
					userId,
					bookId: args.bookId,
					point: previousPoint,
					progressServerTime: currentServerTime,
					recordedAt: now,
					deviceId: existing.progressDeviceId,
					deviceKind: existing.progressDeviceKind,
					cause: "reading",
					largeBackwardJump:
						previousPoint.sectionIndex - nextPoint.sectionIndex >= 2,
					nextPoint,
				});
			}
			await ctx.db.patch(existing._id, patch);
			return {
				id: existing._id,
				accepted: true,
				serverTime: now,
				lastSectionIndex: patch.lastSectionIndex,
				lastBlockIndex: patch.lastBlockIndex,
				lastBlockOffset: patch.lastBlockOffset,
				lastSectionFraction: patch.lastSectionFraction,
			};
		}

		const id = await ctx.db.insert("userBooks", {
			userId,
			bookId: args.bookId,
			...patch,
		});
		return {
			id,
			accepted: true,
			serverTime: now,
			lastSectionIndex: patch.lastSectionIndex,
			lastBlockIndex: patch.lastBlockIndex,
			lastBlockOffset: patch.lastBlockOffset,
			lastSectionFraction: patch.lastSectionFraction,
		};
	},
});

export const listProgressHistory = query({
	args: { bookId: v.id("books") },
	handler: async (ctx, args) => {
		const userId = await requireViewerUserId(ctx);
		await requireBookOwner(ctx, args.bookId);
		const current = await ctx.db
			.query("userBooks")
			.withIndex("by_user_book", (q) =>
				q.eq("userId", userId).eq("bookId", args.bookId),
			)
			.first();
		const history = await ctx.db
			.query("progressHistory")
			.withIndex("by_user_book_recorded", (q) =>
				q.eq("userId", userId).eq("bookId", args.bookId),
			)
			.order("desc")
			.take(HISTORY_LIMIT);
		const currentServerTime = current
			? (current.progressUpdatedAt ??
				(current.progressEditedAt !== undefined ? current.updatedAt : 0))
			: 0;
		return {
			current:
				current && currentServerTime > 0
					? {
							sectionIndex: current.lastSectionIndex ?? 0,
							blockIndex: current.lastBlockIndex ?? 0,
							blockOffset: current.lastBlockOffset ?? 0,
							sectionFraction: current.lastSectionFraction ?? 0,
							serverTime: currentServerTime,
							deviceId: current.progressDeviceId,
							deviceKind: current.progressDeviceKind,
						}
					: null,
			history,
		};
	},
});

export const restoreProgress = mutation({
	args: {
		bookId: v.id("books"),
		historyId: v.id("progressHistory"),
		baseServerTime: v.number(),
		deviceId: v.optional(v.string()),
		deviceKind: v.optional(deviceKindValidator),
	},
	handler: async (ctx, args) => {
		const userId = await requireViewerUserId(ctx);
		const { book } = await requireBookOwner(ctx, args.bookId);
		const checkpoint = await ctx.db.get(args.historyId);
		if (
			!checkpoint ||
			checkpoint.userId !== userId ||
			checkpoint.bookId !== args.bookId
		) {
			throw new Error("Reading-history checkpoint not found.");
		}
		if (
			book.sectionCount !== undefined &&
			checkpoint.sectionIndex >= book.sectionCount
		) {
			throw new Error("That chapter no longer exists in this edition.");
		}
		const existing = await ctx.db
			.query("userBooks")
			.withIndex("by_user_book", (q) =>
				q.eq("userId", userId).eq("bookId", args.bookId),
			)
			.first();
		if (!existing) {
			throw new Error("No current reading position exists.");
		}
		const currentServerTime =
			existing.progressUpdatedAt ??
			(existing.progressEditedAt !== undefined ? existing.updatedAt : 0);
		if (observedServerVersion(args.baseServerTime) < currentServerTime) {
			return {
				accepted: false,
				changed: false,
				serverTime: currentServerTime,
				lastSectionIndex: existing.lastSectionIndex ?? 0,
				lastBlockIndex: existing.lastBlockIndex,
				lastBlockOffset: existing.lastBlockOffset,
				lastSectionFraction: existing.lastSectionFraction,
			};
		}
		const currentPoint = pointFromUserBook(existing, book.sectionCount);
		const restoredPoint = pointFromUserBook(
			{
				lastSectionIndex: checkpoint.sectionIndex,
				lastBlockIndex: checkpoint.blockIndex,
				lastBlockOffset: checkpoint.blockOffset,
				lastSectionFraction: checkpoint.sectionFraction,
			},
			book.sectionCount,
		);
		if (samePoint(currentPoint, restoredPoint)) {
			return {
				accepted: true,
				changed: false,
				serverTime: currentServerTime,
				lastSectionIndex: currentPoint.sectionIndex,
				lastBlockIndex: currentPoint.blockIndex,
				lastBlockOffset: currentPoint.blockOffset,
				lastSectionFraction: currentPoint.sectionFraction,
			};
		}

		const now = nextServerVersion(
			Math.max(currentServerTime, existing.updatedAt),
		);
		await preserveProgressCheckpoint(ctx, {
			userId,
			bookId: args.bookId,
			point: currentPoint,
			progressServerTime: currentServerTime,
			recordedAt: now,
			deviceId: existing.progressDeviceId,
			deviceKind: existing.progressDeviceKind,
			cause: "restore",
			largeBackwardJump:
				currentPoint.sectionIndex - restoredPoint.sectionIndex >= 2,
			force: true,
		});
		await ctx.db.patch(existing._id, {
			lastSectionIndex: restoredPoint.sectionIndex,
			lastBlockIndex: restoredPoint.blockIndex,
			lastBlockOffset: restoredPoint.blockOffset,
			lastSectionFraction: restoredPoint.sectionFraction,
			updatedAt: now,
			lastActivityAt: now,
			progressUpdatedAt: now,
			progressDeviceId: cleanDeviceId(args.deviceId),
			progressDeviceKind: args.deviceKind,
		});
		return {
			accepted: true,
			changed: true,
			serverTime: now,
			lastSectionIndex: restoredPoint.sectionIndex,
			lastBlockIndex: restoredPoint.blockIndex,
			lastBlockOffset: restoredPoint.blockOffset,
			lastSectionFraction: restoredPoint.sectionFraction,
		};
	},
});

export const updateStatus = mutation({
	args: {
		bookId: v.id("books"),
		// null clears the explicit status → the client derives one from progress.
		status: v.union(
			v.literal("reading"),
			v.literal("finished"),
			v.literal("want"),
			v.literal("abandoned"),
			v.null(),
		),
		// Status has its own server version so progress activity cannot make an
		// otherwise-current offline status change stale.
		baseServerTime: v.optional(v.number()),
		deviceId: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		const userId = await requireViewerUserId(ctx);
		await requireBookOwner(ctx, args.bookId);
		const existing = await ctx.db
			.query("userBooks")
			.withIndex("by_user_book", (q) =>
				q.eq("userId", userId).eq("bookId", args.bookId),
			)
			.first();

		const currentServerTime =
			existing?.statusUpdatedAt ??
			(existing?.statusEditedAt !== undefined ? existing.updatedAt : 0);
		// Reject a write based on older server state authored by another device
		// (same-device staleness is a lost acknowledgement — accepted; see
		// rejectsStaleBase). Bump updatedAt so the subscription re-emits and
		// the losing device promptly re-adopts.
		if (
			existing &&
			rejectsStaleBase({
				baseServerTime: args.baseServerTime,
				currentServerTime,
				currentWriterDeviceId: existing.statusDeviceId,
				requestDeviceId: cleanDeviceId(args.deviceId),
			})
		) {
			await ctx.db.patch(existing._id, {
				updatedAt: nextServerVersion(existing.updatedAt),
			});
			return {
				id: existing._id,
				accepted: false,
				serverTime: currentServerTime,
				status: existing.status ?? null,
			};
		}

		const now = nextServerVersion(
			Math.max(currentServerTime, existing?.updatedAt ?? 0),
		);
		// Note: no lastActivityAt here — marking a status is organizing, not
		// reading, so it must not reorder the Recent shelf. A never-opened book
		// marked from the shelf is inserted with lastActivityAt absent, so it
		// sorts last in Recent (behind everything actually read).
		const patch = {
			status: args.status ?? undefined,
			statusUpdatedAt: now,
			statusDeviceId: cleanDeviceId(args.deviceId),
			updatedAt: now,
		};

		if (existing) {
			await ctx.db.patch(existing._id, patch);
			return {
				id: existing._id,
				accepted: true,
				serverTime: now,
				status: args.status,
			};
		}

		const id = await ctx.db.insert("userBooks", {
			userId,
			bookId: args.bookId,
			lastSectionIndex: 0,
			...patch,
		});
		return { id, accepted: true, serverTime: now, status: args.status };
	},
});

export const listRecentByUser = query({
	args: {
		limit: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		const userId = await getViewerUserId(ctx);
		if (!userId) {
			return [];
		}
		const limit = args.limit ?? 8;
		// Recency = reading activity, not the sync clock. Rows with no activity
		// yet (status-only, never opened) have lastActivityAt undefined, which
		// Convex orders before all values → last under desc, i.e. behind every
		// book actually read.
		const entries = await ctx.db
			.query("userBooks")
			.withIndex("by_user_activity", (q) => q.eq("userId", userId))
			.order("desc")
			.take(limit);

		const results = [];
		for (const entry of entries) {
			const book = await ctx.db.get(entry.bookId);
			if (book && book.ownerId === userId) {
				results.push({
					entryId: entry._id,
					book,
					updatedAt: entry.updatedAt,
				});
			}
		}
		return results;
	},
});

export const listByUser = query({
	args: {},
	handler: async (ctx) => {
		const userId = await getViewerUserId(ctx);
		if (!userId) {
			return [];
		}
		const entries = await ctx.db
			.query("userBooks")
			.withIndex("by_user_book", (q) => q.eq("userId", userId))
			.collect();

		const results = [];
		for (const entry of entries) {
			const book = await ctx.db.get(entry.bookId);
			if (!book || book.ownerId !== userId) {
				continue;
			}
			const totalSections = book.sectionCount ?? 0;
			const lastIndex = entry.lastSectionIndex ?? 0;
			// Completed chapters plus the fraction of the current one — a fresh
			// book reads 0%, a 1-chapter book can progress, and finishing the last
			// chapter reaches 100%.
			const progress =
				totalSections > 0
					? Math.min(
							(lastIndex + (entry.lastSectionFraction ?? 0)) / totalSections,
							1,
						)
					: 0;
			results.push({
				bookId: entry.bookId,
				lastSectionTitle: null,
				lastSectionIndex: lastIndex,
				totalSections,
				progress,
				status: entry.status ?? null,
				statusUpdatedAt:
					entry.statusUpdatedAt ??
					(entry.statusEditedAt !== undefined ? entry.updatedAt : 0),
				updatedAt: entry.updatedAt,
			});
		}
		return results;
	},
});
