import { VERSION as SPINE_VERSION } from "@abfcode/spine";
import Dexie, { type Table } from "dexie";
import type { ReadingStatus } from "./status";

// Version of @abfcode/spine that produced the locally stored blocks — taken
// from the library itself (spine ≥0.5 exports VERSION for exactly this), so
// every dependency bump automatically invalidates local parses and books
// re-parse from their raw EPUBs on next open.
export const PARSER_VERSION = SPINE_VERSION;

// ── Row types ────────────────────────────────────────────────────────────────

export type LocalBook = {
	bookId: string; // Convex books._id
	title: string;
	author?: string;
	coverBlob?: Blob;
	coverType?: string;
	sectionCount: number;
	parserVersion: string;
	addedAt: number;
	// Mirrored from the server row (reconcile cache-fill) so series shelves
	// work offline. Not indexed.
	series?: string;
	seriesIndex?: string;
	description?: string;
	sourceUrl?: string;
	// Mirrors the server's coverUpdatedAt for the blob currently cached in
	// coverBlob — when the server value is newer, the blob is stale.
	coverVersion?: number;
};

export type LocalSection = {
	bookId: string;
	orderIndex: number;
	convexId?: string; // Convex sections._id, backfilled after ingest
	title: string;
	depth: number;
	href?: string;
	anchor?: string;
	// undefined = metadata-only row (blocks not cached on this device yet)
	blocks?: unknown[];
};

export type LocalImage = {
	bookId: string;
	href: string;
	blob: Blob;
	contentType?: string;
};

export type LocalBookmark = {
	// Client-generated UUID; the stable identity across devices (the server
	// stores it for idempotent creates and cross-device matching).
	clientKey: string;
	bookId: string;
	sectionIndex: number;
	blockIndex: number;
	offset: number;
	label?: string;
	createdAt: number;
	// Tombstone: set on delete; the row is removed once the server confirms.
	deletedAt?: number;
	// 1 = create or delete not yet acknowledged by the server.
	dirty: 0 | 1;
	convexId?: string;
};

export type LocalProgress = {
	bookId: string;
	sectionIndex: number;
	blockIndex: number;
	// Fraction (0–1) of the way through the anchor block — layout-independent,
	// so a position saved on one device/font size restores exactly on another.
	blockOffset: number;
	// Fraction (0–1) of the way through the whole section — used by percent
	// displays so partial chapters count (a 1-chapter book isn't pinned at 0%).
	sectionFraction?: number;
	// Device wall-clock time used only to coalesce edits on this device. It is
	// never sent to the server or compared with another device's clock.
	editedAt: number;
	// 1 = not yet accepted by the server (offline or pending push).
	dirty: 0 | 1;
	// Server updatedAt of the last remote state merged into this record; pull
	// ordering compares against this, never against device clocks.
	syncedServerTime: number;
};

export type LocalBookStatus = {
	bookId: string;
	// null = user explicitly chose "automatic" (clears the server field); the
	// effective shelf status is then derived from progress.
	status: ReadingStatus | null;
	// Device-local edit order (same convention as progress).
	editedAt: number;
	// 1 = not yet accepted by the server (offline or pending push).
	dirty: 0 | 1;
	// Server updatedAt of the last remote state merged into this record.
	// Undefined means this device has not observed any server status version yet.
	syncedServerTime?: number;
};

export type LocalCollection = {
	// Client-generated UUID; the stable identity across devices (the server
	// stores it for idempotent creates and cross-device matching).
	clientKey: string;
	name: string;
	createdAt: number;
	// Device wall-clock time of the last rename (LWW).
	nameEditedAt: number;
	// Server-issued version of the last collection name merged here.
	syncedServerTime?: number;
	// Tombstone: set on delete; the row is removed once the server confirms.
	deletedAt?: number;
	// 1 = create/rename/delete not yet acknowledged by the server.
	dirty: 0 | 1;
	convexId?: string;
};

export type LocalCollectionBook = {
	clientKey: string;
	// LocalCollection.clientKey — references the collection by its client
	// identity so memberships of an offline-created collection work before the
	// collection has a convexId.
	collectionKey: string;
	bookId: string;
	createdAt: number;
	// Local-only operation order for add/remove/re-add races on this device.
	editedAt?: number;
	// Last server version of this collection/book membership that was observed.
	syncedServerTime?: number;
	deletedAt?: number;
	dirty: 0 | 1;
	convexId?: string;
};

export type LocalPendingUpload = {
	bookId: string;
	fileName: string;
	blob: Blob;
	updatedAt: number;
	lastError?: string;
};

export type ReaderSettingField =
	| "fontScale"
	| "lineHeight"
	| "contentWidth"
	| "theme"
	| "fontFamily";

export type LocalReaderSettings = {
	key: "reader";
	fontScale: number;
	lineHeight: number;
	contentWidth: number;
	theme: string;
	fontFamily: string;
	dirtyFields: ReaderSettingField[];
	syncedServerTimes: Record<ReaderSettingField, number>;
	// Device-local edit order per field (same convention as progress.editedAt).
	// A push response may only clear a field's dirty state when no edit newer
	// than the pushed one has landed — value equality is not a causal guard
	// (an old response for value X must not clear a newer re-edit back to X).
	// Optional: rows written before this field existed carry no stamps.
	fieldEditedAt?: Partial<Record<ReaderSettingField, number>>;
};

// ── Database ─────────────────────────────────────────────────────────────────

class LibriumDB extends Dexie {
	books!: Table<LocalBook, string>;
	sections!: Table<LocalSection, [string, number]>;
	images!: Table<LocalImage, [string, string]>;
	progress!: Table<LocalProgress, string>;
	bookmarks!: Table<LocalBookmark, string>;
	bookStatus!: Table<LocalBookStatus, string>;
	collections!: Table<LocalCollection, string>;
	collectionBooks!: Table<LocalCollectionBook, string>;
	pendingUploads!: Table<LocalPendingUpload, string>;
	settings!: Table<LocalReaderSettings, string>;

	constructor(name = "librium") {
		super(name);
		this.version(1).stores({
			books: "bookId",
			sections: "[bookId+orderIndex], bookId",
			images: "[bookId+href], bookId",
		});
		this.version(2).stores({
			progress: "bookId",
		});
		this.version(3).stores({
			bookmarks: "clientKey, bookId",
		});
		this.version(4).stores({
			bookStatus: "bookId",
			collections: "clientKey",
			collectionBooks: "clientKey, collectionKey, bookId",
		});
		this.version(5).stores({
			pendingUploads: "bookId",
		});
		this.version(6).stores({
			settings: "key",
		});
	}
}

export type LibriumDatabase = LibriumDB;

const ACTIVE_USER_KEY = "librium:activeLocalUser";
const databaseNameForUser = (userId: string) =>
	`librium:user:${encodeURIComponent(userId)}`;

const storedUserId =
	typeof window !== "undefined"
		? window.localStorage.getItem(ACTIVE_USER_KEY)
		: null;

// A live exported binding: switching accounts replaces the Dexie instance,
// and the keyed app boundary remounts every consumer against the new one.
export let db = new LibriumDB(
	storedUserId ? databaseNameForUser(storedUserId) : "librium",
);

export const activeLocalUserId = () =>
	typeof window !== "undefined"
		? window.localStorage.getItem(ACTIVE_USER_KEY)
		: null;

export function activateUserDatabase(userId: string) {
	const name = databaseNameForUser(userId);
	if (db.name !== name) {
		db.close();
		db = new LibriumDB(name);
	}
	window.localStorage.setItem(ACTIVE_USER_KEY, userId);
}

export function forgetActiveUserDatabase() {
	window.localStorage.removeItem(ACTIVE_USER_KEY);
	db.close();
	db = new LibriumDB("librium:signed-out");
}

// Copy only rows whose server book IDs are confirmed to belong to this user.
// The legacy DB remains intact so another account that previously shared the
// origin can migrate its own rows later; the per-user marker makes this one-shot.
export async function migrateLegacyDataForUser(
	userId: string,
	ownedBookIds: string[],
	targetDb: LibriumDatabase = db,
) {
	const marker = `librium:legacyMigrated:${userId}`;
	if (
		typeof window === "undefined" ||
		window.localStorage.getItem(marker) === "true" ||
		targetDb.name === "librium"
	) {
		return;
	}
	const owned = new Set(ownedBookIds);
	const legacy = new LibriumDB("librium");
	try {
		const [
			books,
			sections,
			images,
			progress,
			bookmarks,
			bookStatus,
			memberships,
			pendingUploads,
		] = await Promise.all([
			legacy.books.filter((row) => owned.has(row.bookId)).toArray(),
			legacy.sections.filter((row) => owned.has(row.bookId)).toArray(),
			legacy.images.filter((row) => owned.has(row.bookId)).toArray(),
			legacy.progress.filter((row) => owned.has(row.bookId)).toArray(),
			legacy.bookmarks.filter((row) => owned.has(row.bookId)).toArray(),
			legacy.bookStatus.filter((row) => owned.has(row.bookId)).toArray(),
			legacy.collectionBooks.filter((row) => owned.has(row.bookId)).toArray(),
			legacy.pendingUploads.filter((row) => owned.has(row.bookId)).toArray(),
		]);
		const collectionKeys = new Set(memberships.map((row) => row.collectionKey));
		const collections = await legacy.collections
			.filter((row) => collectionKeys.has(row.clientKey))
			.toArray();
		await targetDb.transaction(
			"rw",
			[
				targetDb.books,
				targetDb.sections,
				targetDb.images,
				targetDb.progress,
				targetDb.bookmarks,
				targetDb.bookStatus,
				targetDb.collections,
				targetDb.collectionBooks,
				targetDb.pendingUploads,
			],
			async () => {
				await targetDb.books.bulkPut(books);
				await targetDb.sections.bulkPut(sections);
				await targetDb.images.bulkPut(images);
				await targetDb.progress.bulkPut(progress);
				await targetDb.bookmarks.bulkPut(bookmarks);
				await targetDb.bookStatus.bulkPut(bookStatus);
				await targetDb.collections.bulkPut(collections);
				await targetDb.collectionBooks.bulkPut(memberships);
				await targetDb.pendingUploads.bulkPut(pendingUploads);
			},
		);
		window.localStorage.setItem(marker, "true");
	} finally {
		legacy.close();
	}
}

// Section key used when a section exists locally but its Convex id is not
// known yet (e.g. ingest backfill failed). Never sent to Convex functions.
export const localSectionKey = (bookId: string, orderIndex: number) =>
	`local:${bookId}:${orderIndex}`;

export const isLocalSectionKey = (id: string) => id.startsWith("local:");

// ── Import path ──────────────────────────────────────────────────────────────

export async function saveImportedBook(
	input: {
		bookId: string;
		title: string;
		author?: string;
		cover?: { blob: Blob; contentType?: string };
		sections: {
			orderIndex: number;
			title: string;
			depth: number;
			href?: string;
			anchor?: string;
			blocks: unknown[];
		}[];
		images: { href: string; blob: Blob; contentType?: string }[];
	},
	targetDb: LibriumDatabase = db,
) {
	const { bookId } = input;
	await targetDb.transaction(
		"rw",
		targetDb.books,
		targetDb.sections,
		targetDb.images,
		async () => {
			await targetDb.books.put({
				bookId,
				title: input.title,
				author: input.author,
				coverBlob: input.cover?.blob,
				coverType: input.cover?.contentType,
				sectionCount: input.sections.length,
				parserVersion: PARSER_VERSION,
				addedAt: Date.now(),
			});
			await targetDb.sections.bulkPut(
				input.sections.map((s) => ({ bookId, ...s })),
			);
			await targetDb.images.bulkPut(
				input.images.map((img) => ({ bookId, ...img })),
			);
		},
	);
}

export async function getLocalBlocks(
	bookId: string,
	orderIndex: number,
): Promise<unknown[] | null> {
	const row = await db.sections.get([bookId, orderIndex]);
	return row?.blocks ?? null;
}

// Remove this device's *content cache* for a book (sections + images) while
// keeping the shelf row (title/cover), progress, and bookmarks — the book
// stays in the library everywhere and re-seeds from R2 on demand.
export async function removeLocalContent(
	bookId: string,
	targetDb: LibriumDatabase = db,
) {
	await targetDb.transaction(
		"rw",
		targetDb.books,
		targetDb.sections,
		targetDb.images,
		async () => {
			await targetDb.sections.where("bookId").equals(bookId).delete();
			await targetDb.images.where("bookId").equals(bookId).delete();
			// parserVersion doubles as the "content is on this device" marker.
			await targetDb.books
				.where("bookId")
				.equals(bookId)
				.modify({ parserVersion: "" });
		},
	);
}

// Delete content rows whose book no longer has a shelf row — a safety net
// for interrupted deletes and for legacy dev data (sections/images are pure
// derived content with no sync semantics, so removal is always safe; they
// re-seed from R2 if ever needed). Orphans otherwise accumulate forever and
// inflate the storage figure.
export async function purgeOrphanedContent(targetDb: LibriumDatabase = db) {
	await targetDb.transaction(
		"rw",
		targetDb.books,
		targetDb.sections,
		targetDb.images,
		async () => {
			const known = new Set(
				(await targetDb.books.toCollection().primaryKeys()) as string[],
			);
			const sectionOwners = (await targetDb.sections
				.orderBy("bookId")
				.uniqueKeys()) as string[];
			const imageOwners = (await targetDb.images
				.orderBy("bookId")
				.uniqueKeys()) as string[];
			for (const bookId of new Set([...sectionOwners, ...imageOwners])) {
				if (!known.has(bookId)) {
					await targetDb.sections.where("bookId").equals(bookId).delete();
					await targetDb.images.where("bookId").equals(bookId).delete();
				}
			}
		},
	);
}

// ── Delete parity ────────────────────────────────────────────────────────────

export async function deleteLocalBook(
	bookId: string,
	targetDb: LibriumDatabase = db,
) {
	await targetDb.transaction(
		"rw",
		[
			targetDb.books,
			targetDb.sections,
			targetDb.images,
			targetDb.progress,
			targetDb.bookmarks,
			targetDb.bookStatus,
			targetDb.collectionBooks,
			targetDb.pendingUploads,
		],
		async () => {
			await targetDb.books.delete(bookId);
			await targetDb.sections.where("bookId").equals(bookId).delete();
			await targetDb.images.where("bookId").equals(bookId).delete();
			await targetDb.progress.delete(bookId);
			await targetDb.bookmarks.where("bookId").equals(bookId).delete();
			await targetDb.bookStatus.delete(bookId);
			await targetDb.collectionBooks.where("bookId").equals(bookId).delete();
			await targetDb.pendingUploads.delete(bookId);
		},
	);
}
