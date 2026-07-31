import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import {
	getViewerUserId,
	requireBookOwner,
	requireViewerUserId,
} from "./authHelpers";
import {
	cleanDeviceId,
	nextServerVersion,
	rejectsStaleBase,
} from "./syncVersion";

// Collections: user-named, many-to-many book groups. Same sync plane as
// bookmarks — client-generated clientKeys make offline creates idempotent,
// deletedAt tombstones propagate deletes instead of resurrecting rows.

export const listByUser = query({
	args: {},
	handler: async (ctx) => {
		const userId = await getViewerUserId(ctx);
		if (!userId) {
			return [];
		}
		// Tombstones included: clients need them to settle local deletes.
		return await ctx.db
			.query("collections")
			.withIndex("by_user", (q) => q.eq("userId", userId))
			.collect();
	},
});

export const listMembershipsByUser = query({
	args: {},
	handler: async (ctx) => {
		const userId = await getViewerUserId(ctx);
		if (!userId) {
			return [];
		}
		return await ctx.db
			.query("collectionBooks")
			.withIndex("by_user", (q) => q.eq("userId", userId))
			.collect();
	},
});

export const createCollection = mutation({
	args: {
		name: v.string(),
		// Client-generated key: retried offline pushes create exactly one row.
		clientKey: v.string(),
		createdAt: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		const userId = await requireViewerUserId(ctx);
		const name = args.name.trim();
		if (!name) {
			throw new Error("Collection name cannot be empty.");
		}
		const existing = await ctx.db
			.query("collections")
			.withIndex("by_user", (q) => q.eq("userId", userId))
			.collect();
		const match = existing.find((c) => c.clientKey === args.clientKey);
		if (match) {
			return {
				id: match._id,
				// Return only the version this create originally observed. Returning a
				// later rename version would let an unacknowledged stale local rename
				// masquerade as though it had observed (and could overwrite) that rename.
				serverTime: match.createdServerTime ?? 0,
			};
		}
		const now = nextServerVersion(0);
		const id = await ctx.db.insert("collections", {
			userId,
			name,
			clientKey: args.clientKey,
			createdAt: args.createdAt ?? now,
			createdServerTime: now,
			updatedAt: now,
			nameUpdatedAt: now,
		});
		return { id, serverTime: now };
	},
});

export const renameCollection = mutation({
	args: {
		collectionId: v.id("collections"),
		name: v.string(),
		baseServerTime: v.optional(v.number()),
		deviceId: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		const userId = await requireViewerUserId(ctx);
		const collection = await ctx.db.get(args.collectionId);
		if (!collection || collection.userId !== userId) {
			throw new Error("Collection not found.");
		}
		const currentServerTime = collection.nameUpdatedAt ?? collection.updatedAt;
		if (collection.deletedAt !== undefined) {
			return {
				accepted: false,
				serverTime: currentServerTime,
				name: collection.name,
			};
		}
		const name = args.name.trim();
		if (!name) {
			throw new Error("Collection name cannot be empty.");
		}
		if (
			rejectsStaleBase({
				baseServerTime: args.baseServerTime,
				currentServerTime,
				currentWriterDeviceId: collection.nameDeviceId,
				requestDeviceId: cleanDeviceId(args.deviceId),
			})
		) {
			return {
				accepted: false,
				serverTime: currentServerTime,
				name: collection.name,
			};
		}
		const now = nextServerVersion(currentServerTime);
		await ctx.db.patch(args.collectionId, {
			name,
			nameUpdatedAt: now,
			nameDeviceId: cleanDeviceId(args.deviceId),
			updatedAt: now,
		});
		return { accepted: true, serverTime: now, name };
	},
});

export const deleteCollection = mutation({
	args: {
		collectionId: v.id("collections"),
	},
	handler: async (ctx, args) => {
		const userId = await requireViewerUserId(ctx);
		const collection = await ctx.db.get(args.collectionId);
		if (!collection || collection.userId !== userId) {
			return;
		}
		const now = Date.now();
		// Tombstone the collection and cascade tombstones to its memberships so
		// every device's merge pass drops them (a hard delete would leave other
		// devices' local rows orphaned but alive).
		await ctx.db.patch(args.collectionId, { deletedAt: now, updatedAt: now });
		const memberships = await ctx.db
			.query("collectionBooks")
			.withIndex("by_collection", (q) =>
				q.eq("collectionId", args.collectionId),
			)
			.collect();
		for (const membership of memberships) {
			if (membership.deletedAt === undefined) {
				await ctx.db.patch(membership._id, { deletedAt: now, updatedAt: now });
			}
		}
	},
});

export const addBookMembership = mutation({
	args: {
		collectionId: v.id("collections"),
		bookId: v.id("books"),
		clientKey: v.string(),
		createdAt: v.optional(v.number()),
		baseServerTime: v.optional(v.number()),
		deviceId: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		const userId = await requireViewerUserId(ctx);
		await requireBookOwner(ctx, args.bookId);
		const collection = await ctx.db.get(args.collectionId);
		if (!collection || collection.userId !== userId) {
			throw new Error("Collection not found.");
		}
		// Deleted while this device was offline: drop the add — the client's
		// merge pass purges its local rows when it sees the tombstone.
		if (collection.deletedAt !== undefined) {
			return null;
		}
		const existing = await ctx.db
			.query("collectionBooks")
			.withIndex("by_collection", (q) =>
				q.eq("collectionId", args.collectionId),
			)
			.collect();
		const tupleRows = existing.filter((m) => m.bookId === args.bookId);
		const currentServerTime = tupleRows.reduce(
			(latest, row) => Math.max(latest, row.updatedAt),
			0,
		);
		const keyMatch = tupleRows.find((m) => m.clientKey === args.clientKey);
		// Different devices generate different client keys for the same logical
		// membership. Keep exactly one live row per collection/book tuple so a
		// later remove cannot reveal a duplicate add.
		const liveMatch = tupleRows.find((m) => m.deletedAt === undefined);
		if (liveMatch) {
			// Collapse any legacy duplicate live rows while this tuple is touched.
			for (const duplicate of tupleRows) {
				if (
					duplicate._id !== liveMatch._id &&
					duplicate.deletedAt === undefined
				) {
					await ctx.db.patch(duplicate._id, {
						deletedAt: currentServerTime,
						updatedAt: currentServerTime,
					});
				}
			}
			return {
				id: liveMatch._id,
				accepted: true,
				serverTime: currentServerTime,
				deleted: false,
			};
		}
		const newestTupleRow = tupleRows.reduce<
			(typeof tupleRows)[number] | undefined
		>(
			(latest, row) =>
				latest === undefined || row.updatedAt > latest.updatedAt ? row : latest,
			undefined,
		);
		if (
			currentServerTime > 0 &&
			rejectsStaleBase({
				baseServerTime: args.baseServerTime,
				currentServerTime,
				currentWriterDeviceId: newestTupleRow?.writerDeviceId,
				requestDeviceId: cleanDeviceId(args.deviceId),
			})
		) {
			const tombstone = keyMatch ?? tupleRows[0];
			return {
				id: tombstone?._id ?? null,
				accepted: false,
				serverTime: currentServerTime,
				deleted: true,
			};
		}
		const now = nextServerVersion(currentServerTime);
		const tombstone = keyMatch ?? tupleRows[0];
		if (tombstone) {
			await ctx.db.patch(tombstone._id, {
				deletedAt: undefined,
				updatedAt: now,
				writerDeviceId: cleanDeviceId(args.deviceId),
			});
			return {
				id: tombstone._id,
				accepted: true,
				serverTime: now,
				deleted: false,
			};
		}
		const id = await ctx.db.insert("collectionBooks", {
			userId,
			collectionId: args.collectionId,
			bookId: args.bookId,
			clientKey: args.clientKey,
			createdAt: args.createdAt ?? now,
			updatedAt: now,
			writerDeviceId: cleanDeviceId(args.deviceId),
		});
		return { id, accepted: true, serverTime: now, deleted: false };
	},
});

export const removeBookMembership = mutation({
	args: {
		membershipId: v.id("collectionBooks"),
		baseServerTime: v.optional(v.number()),
		deviceId: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		const userId = await requireViewerUserId(ctx);
		const membership = await ctx.db.get(args.membershipId);
		if (!membership) {
			return;
		}
		if (membership.userId !== userId) {
			throw new Error("Not authorized to modify this collection.");
		}
		const siblings = await ctx.db
			.query("collectionBooks")
			.withIndex("by_collection", (q) =>
				q.eq("collectionId", membership.collectionId),
			)
			.collect();
		const tupleRows = siblings.filter(
			(row) => row.bookId === membership.bookId,
		);
		const currentServerTime = tupleRows.reduce(
			(latest, row) => Math.max(latest, row.updatedAt),
			0,
		);
		const newestTupleRow = tupleRows.reduce<
			(typeof tupleRows)[number] | undefined
		>(
			(latest, row) =>
				latest === undefined || row.updatedAt > latest.updatedAt ? row : latest,
			undefined,
		);
		if (
			rejectsStaleBase({
				baseServerTime: args.baseServerTime,
				currentServerTime,
				currentWriterDeviceId: newestTupleRow?.writerDeviceId,
				requestDeviceId: cleanDeviceId(args.deviceId),
			})
		) {
			return {
				accepted: false,
				serverTime: currentServerTime,
				deleted: tupleRows.every((row) => row.deletedAt !== undefined),
			};
		}
		const now = nextServerVersion(currentServerTime);
		for (const row of tupleRows) {
			if (row.deletedAt === undefined) {
				await ctx.db.patch(row._id, {
					deletedAt: now,
					updatedAt: now,
					writerDeviceId: cleanDeviceId(args.deviceId),
				});
			}
		}
		return { accepted: true, serverTime: now, deleted: true };
	},
});

// Rolling-deploy compatibility for already-open/PWA-cached clients. The old
// add endpoint returned only an id. It may create a brand-new tuple or resolve
// an existing live tuple, but it never resurrects a tombstone because it has no
// causal base with which to prove the delete was observed.
export const addBookToCollection = mutation({
	args: {
		collectionId: v.id("collections"),
		bookId: v.id("books"),
		clientKey: v.string(),
		createdAt: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		const userId = await requireViewerUserId(ctx);
		await requireBookOwner(ctx, args.bookId);
		const collection = await ctx.db.get(args.collectionId);
		if (
			!collection ||
			collection.userId !== userId ||
			collection.deletedAt !== undefined
		) {
			return null;
		}
		const existing = await ctx.db
			.query("collectionBooks")
			.withIndex("by_collection", (q) =>
				q.eq("collectionId", args.collectionId),
			)
			.collect();
		const tupleRows = existing.filter((row) => row.bookId === args.bookId);
		const match =
			tupleRows.find((row) => row.clientKey === args.clientKey) ??
			tupleRows.find((row) => row.deletedAt === undefined) ??
			tupleRows[0];
		if (match) {
			return match._id;
		}
		const now = nextServerVersion(0);
		return await ctx.db.insert("collectionBooks", {
			userId,
			collectionId: args.collectionId,
			bookId: args.bookId,
			clientKey: args.clientKey,
			createdAt: args.createdAt ?? now,
			updatedAt: now,
		});
	},
});

// Rows last changed before the versioned membership protocol shipped can be
// safely removed by an old client. Newer rows require the versioned endpoint;
// treating an unversioned remove as a no-op is safer than letting a stale PWA
// erase a later intentional re-add.
const MEMBERSHIP_CAUSAL_VERSION_EPOCH = Date.UTC(2026, 6, 15);

export const removeBookFromCollection = mutation({
	args: { membershipId: v.id("collectionBooks") },
	handler: async (ctx, args) => {
		const userId = await requireViewerUserId(ctx);
		const membership = await ctx.db.get(args.membershipId);
		if (!membership) return;
		if (membership.userId !== userId) {
			throw new Error("Not authorized to modify this collection.");
		}
		if (membership.updatedAt >= MEMBERSHIP_CAUSAL_VERSION_EPOCH) {
			return;
		}
		const now = nextServerVersion(membership.updatedAt);
		await ctx.db.patch(membership._id, { deletedAt: now, updatedAt: now });
	},
});
