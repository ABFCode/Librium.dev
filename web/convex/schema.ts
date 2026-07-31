import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// Blobs live in Cloudflare R2 (raw EPUB + cover only — ROADMAP Phase 5).
// Parsed content is derived data: devices re-parse the EPUB locally, so there
// are no section/asset tables server-side. Convex holds auth, book metadata,
// and the tiny sync plane (progress, bookmarks).

const users = defineTable({
	authProvider: v.string(),
	externalId: v.string(),
	email: v.optional(v.string()),
	name: v.optional(v.string()),
	createdAt: v.number(),
}).index("by_external_id", ["authProvider", "externalId"]);

const books = defineTable({
	ownerId: v.id("users"),
	title: v.string(),
	author: v.optional(v.string()),
	language: v.optional(v.string()),
	publisher: v.optional(v.string()),
	publishedAt: v.optional(v.string()),
	series: v.optional(v.string()),
	seriesIndex: v.optional(v.string()),
	subjects: v.optional(v.array(v.string())),
	description: v.optional(v.string()),
	// Linked source page (e.g. a NovelUpdates series URL) — set by the user,
	// used for "Open source page" and page-based metadata fetch.
	sourceUrl: v.optional(v.string()),
	identifiers: v.optional(
		v.array(
			v.object({
				id: v.string(),
				scheme: v.string(),
				value: v.string(),
				type: v.string(),
			}),
		),
	),
	sectionCount: v.optional(v.number()),
	// R2 object keys. epubKey is the master copy (device seeding + download);
	// set by attachFiles once the client upload completes.
	epubKey: v.optional(v.string()),
	coverKey: v.optional(v.string()),
	// Bumped whenever coverKey is (re)attached — the R2 key never changes on
	// replacement, so this is how other devices detect a stale local cover.
	coverUpdatedAt: v.optional(v.number()),
	fileName: v.optional(v.string()),
	fileSize: v.optional(v.number()),
	// SHA-256 of the final EPUB bytes. Per-owner idempotency key for imports.
	contentHash: v.optional(v.string()),
	createdAt: v.number(),
	updatedAt: v.number(),
})
	.index("by_owner", ["ownerId", "updatedAt"])
	.index("by_owner_hash", ["ownerId", "contentHash"]);

const userBooks = defineTable({
	userId: v.id("users"),
	bookId: v.id("books"),
	lastSectionIndex: v.number(),
	lastBlockIndex: v.optional(v.number()),
	// Fraction (0–1) within the anchor block (layout-independent).
	lastBlockOffset: v.optional(v.number()),
	// Fraction (0–1) through the whole section — lets percent displays count
	// partial chapters (completed + fraction) instead of whole chapters only.
	lastSectionFraction: v.optional(v.number()),
	updatedAt: v.number(),
	// Server time of the last *reading* activity (open or progress) — drives the
	// "Recent" shelf sort. Deliberately separate from updatedAt: status edits
	// bump updatedAt (the sync clock the status merge orders on) but must NOT
	// reorder Recent, so recency reads from this field instead.
	lastActivityAt: v.optional(v.number()),
	// Legacy client-clock fields retained for existing rows during the rolling
	// migration. New clients never compare or write them.
	progressEditedAt: v.optional(v.number()),
	// Server-issued version for progress only. Offline writes carry the last
	// version they observed; a write based on older state is rejected.
	progressUpdatedAt: v.optional(v.number()),
	// Coarse, privacy-friendly origin of the current reading position. The
	// opaque installation id distinguishes two devices of the same kind without
	// collecting a user-entered device name or hardware fingerprint.
	progressDeviceId: v.optional(v.string()),
	progressDeviceKind: v.optional(
		v.union(
			v.literal("phone"),
			v.literal("tablet"),
			v.literal("computer"),
			v.literal("unknown"),
		),
	),
	// Explicit reading status; absent = derived from progress on the client.
	// Own LWW clock, disjoint from progressEditedAt — status and progress are
	// edited independently and must never clobber each other.
	status: v.optional(
		v.union(
			v.literal("reading"),
			v.literal("finished"),
			v.literal("want"),
			v.literal("abandoned"),
		),
	),
	statusEditedAt: v.optional(v.number()),
	// Server-issued version for explicit status only (independent of progress).
	statusUpdatedAt: v.optional(v.number()),
	// Installation id that authored the current status — powers the same-device
	// stale-base acceptance rule (see syncVersion.rejectsStaleBase).
	statusDeviceId: v.optional(v.string()),
})
	.index("by_user_book", ["userId", "bookId"])
	.index("by_user_updated", ["userId", "updatedAt"])
	.index("by_user_activity", ["userId", "lastActivityAt"])
	.index("by_book", ["bookId"]);

// Append-only recovery checkpoints for accepted reading positions. These are
// deliberately separate from userBooks: restoring a checkpoint creates a new
// current progress version and first snapshots the displaced current value.
// Rewinding the sync clock itself would let stale devices overwrite the
// restore, so history is data, never a rollback of server causality.
const progressHistory = defineTable({
	userId: v.id("users"),
	bookId: v.id("books"),
	sectionIndex: v.number(),
	blockIndex: v.optional(v.number()),
	blockOffset: v.optional(v.number()),
	sectionFraction: v.optional(v.number()),
	progressServerTime: v.number(),
	recordedAt: v.number(),
	deviceId: v.optional(v.string()),
	deviceKind: v.optional(
		v.union(
			v.literal("phone"),
			v.literal("tablet"),
			v.literal("computer"),
			v.literal("unknown"),
		),
	),
	cause: v.union(v.literal("reading"), v.literal("restore")),
	largeBackwardJump: v.optional(v.boolean()),
})
	.index("by_user_book_recorded", ["userId", "bookId", "recordedAt"])
	.index("by_book", ["bookId"]);

const userSettings = defineTable({
	userId: v.id("users"),
	fontScale: v.number(),
	lineHeight: v.number(),
	contentWidth: v.number(),
	theme: v.string(),
	// Reading font: "sans" (default) or "serif". Optional for pre-existing rows.
	fontFamily: v.optional(v.string()),
	fontScaleUpdatedAt: v.optional(v.number()),
	lineHeightUpdatedAt: v.optional(v.number()),
	contentWidthUpdatedAt: v.optional(v.number()),
	themeUpdatedAt: v.optional(v.number()),
	fontFamilyUpdatedAt: v.optional(v.number()),
	// Installation id that authored each field's current value — powers the
	// same-device stale-base acceptance rule (syncVersion.rejectsStaleBase).
	fieldDeviceIds: v.optional(
		v.object({
			fontScale: v.optional(v.string()),
			lineHeight: v.optional(v.string()),
			contentWidth: v.optional(v.string()),
			theme: v.optional(v.string()),
			fontFamily: v.optional(v.string()),
		}),
	),
	updatedAt: v.number(),
}).index("by_user", ["userId"]);

// User-named book groups (many-to-many via collectionBooks). Same offline
// sync plane as bookmarks: client-generated clientKey for idempotent offline
// creates, deletedAt tombstones so deletes propagate across devices.
const collections = defineTable({
	userId: v.id("users"),
	name: v.string(),
	clientKey: v.string(),
	createdAt: v.number(),
	// Immutable server version assigned when the collection was first created.
	// An idempotent create retry returns this base, not a later rename version.
	createdServerTime: v.optional(v.number()),
	updatedAt: v.number(),
	deletedAt: v.optional(v.number()),
	// Legacy device edit marker retained for old rows; never used for conflicts.
	nameEditedAt: v.optional(v.number()),
	// Server-issued version for collection names. nameEditedAt is legacy.
	nameUpdatedAt: v.optional(v.number()),
	// Installation id that authored the current name — powers the same-device
	// stale-base acceptance rule (syncVersion.rejectsStaleBase).
	nameDeviceId: v.optional(v.string()),
})
	.index("by_user", ["userId", "updatedAt"])
	.index("by_deleted", ["deletedAt"]);

const collectionBooks = defineTable({
	userId: v.id("users"),
	collectionId: v.id("collections"),
	bookId: v.id("books"),
	clientKey: v.string(),
	createdAt: v.number(),
	updatedAt: v.number(),
	deletedAt: v.optional(v.number()),
	// Installation id that authored the current membership state — powers the
	// same-device stale-base acceptance rule (syncVersion.rejectsStaleBase).
	writerDeviceId: v.optional(v.string()),
})
	.index("by_user", ["userId", "updatedAt"])
	.index("by_collection", ["collectionId"])
	.index("by_book", ["bookId"])
	.index("by_deleted", ["deletedAt"]);

const bookmarks = defineTable({
	userId: v.id("users"),
	bookId: v.id("books"),
	sectionIndex: v.number(),
	blockIndex: v.number(),
	offset: v.number(),
	label: v.optional(v.string()),
	createdAt: v.number(),
	// Sync (ROADMAP Phase 4): client-generated key for idempotent offline
	// creates; deletedAt is a tombstone so deletes propagate instead of
	// resurrecting on other devices. Tombstones remain until a future
	// acknowledgement-based compactor can prove every device observed them.
	clientKey: v.optional(v.string()),
	updatedAt: v.optional(v.number()),
	deletedAt: v.optional(v.number()),
})
	.index("by_user_book", ["userId", "bookId"])
	.index("by_book", ["bookId"])
	// Retained for future acknowledgement-based compaction. Age alone is never
	// sufficient: a long-offline device could otherwise resurrect a deletion.
	.index("by_deleted", ["deletedAt"]);

export default defineSchema({
	users,
	books,
	userBooks,
	progressHistory,
	userSettings,
	bookmarks,
	collections,
	collectionBooks,
});
