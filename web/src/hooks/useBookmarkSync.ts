import { useMutation, useQuery } from "convex/react";
import { useLiveQuery } from "dexie-react-hooks";
import { useCallback, useEffect, useMemo } from "react";
import { api } from "../../convex/_generated/api";
import { db } from "../lib/db";
import { useSyncPushQueue } from "./useSyncPushQueue";
import { useSyncWakeSignal } from "./useSyncWakeSignal";

// Local-first bookmarks with tombstone sync (ROADMAP Phase 4).
//
// - Create/delete write to IndexedDB first (instant, offline-capable) and
//   mark the row dirty.
// - Dirty creates push via an idempotent mutation (clientKey), dirty deletes
//   push as server tombstones — so a delete on one device propagates instead
//   of being resurrected by another device's copy.
// - Merge adopts remote rows (matching by convexId, then clientKey), applies
//   remote tombstones, and purges local rows whose server row disappeared.

type UseBookmarkSyncArgs = {
	bookId: string;
	canQuery: boolean;
};

export function useBookmarkSync({ bookId, canQuery }: UseBookmarkSyncArgs) {
	const syncDb = db;
	const createRemote = useMutation(api.bookmarks.createBookmark);
	const deleteRemote = useMutation(api.bookmarks.deleteBookmark);
	const {
		signal: syncWakeSignal,
		retry: retrySync,
		settled: settleSync,
	} = useSyncWakeSignal();
	const remote = useQuery(
		api.bookmarks.listByUserBook,
		canQuery ? { bookId: bookId as never } : "skip",
	);
	const localAll = useLiveQuery(
		() => syncDb.bookmarks.where("bookId").equals(bookId).toArray(),
		[bookId],
	);

	// What the UI renders: live (non-tombstoned) rows, oldest first.
	const bookmarks = useMemo(() => {
		if (localAll === undefined) {
			return undefined;
		}
		return localAll
			.filter((b) => !b.deletedAt)
			.sort((a, b) => a.createdAt - b.createdAt);
	}, [localAll]);

	// Merge remote state into the local store.
	useEffect(() => {
		if (!remote || localAll === undefined) {
			return;
		}
		void (async () => {
			const byConvexId = new Map(
				localAll.flatMap((l) => (l.convexId ? [[l.convexId, l] as const] : [])),
			);
			const byClientKey = new Map(localAll.map((l) => [l.clientKey, l]));
			const remoteIds = new Set<string>();
			for (const r of remote) {
				remoteIds.add(r._id as string);
				const local =
					byConvexId.get(r._id as string) ??
					(r.clientKey ? byClientKey.get(r.clientKey) : undefined);
				try {
					if (r.deletedAt) {
						// Remote tombstone: drop any local copy (dirty deletes of the
						// same row are also settled — the server already deleted it).
						if (local) {
							await syncDb.bookmarks.delete(local.clientKey);
						}
						continue;
					}
					if (!local) {
						await syncDb.bookmarks.put({
							clientKey: r.clientKey ?? `remote:${r._id}`,
							bookId,
							sectionIndex: r.sectionIndex,
							blockIndex: r.blockIndex,
							offset: r.offset,
							label: r.label ?? undefined,
							createdAt: r.createdAt,
							dirty: 0,
							convexId: r._id as string,
						});
						continue;
					}
					if (!local.convexId) {
						// Our offline create landed (matched by clientKey) — record the
						// id; keep dirty if a delete is still pending for it.
						await syncDb.bookmarks
							.where("clientKey")
							.equals(local.clientKey)
							.modify((row) => {
								row.convexId = r._id as string;
								if (!row.deletedAt) {
									row.dirty = 0;
								}
							});
					}
				} catch {
					// IndexedDB hiccup — retried on the next merge.
				}
			}
			// Local rows that reference a server row that no longer exists
			// (hard-deleted/compacted): purge. Rows without a convexId are pending
			// creates — unless they are tombstoned creates that never landed.
			for (const l of localAll) {
				try {
					if (l.convexId && !remoteIds.has(l.convexId)) {
						await syncDb.bookmarks.delete(l.clientKey);
					} else if (!l.convexId && l.deletedAt) {
						const landed = remote.some((r) => r.clientKey === l.clientKey);
						if (!landed) {
							await syncDb.bookmarks.delete(l.clientKey);
						}
					}
				} catch {
					// Retried on the next merge.
				}
			}
		})();
	}, [remote, localAll, bookId]);

	// Push dirty rows (fires on edit and on reconnect). SyncPushQueue
	// serializes passes and abandons one wedged on a never-settling mutation.
	// No stale-base handling needed here: creates are idempotent (clientKey)
	// and deletes are tombstones, both safe under duplicate delivery.
	const pushQueue = useSyncPushQueue(retrySync);
	useEffect(() => {
		void syncWakeSignal; // reconnect/backoff trigger; durable rows are re-read below
		if (!canQuery || !localAll) {
			return;
		}
		const dirty = localAll.filter((l) => l.dirty);
		if (dirty.length === 0) {
			return;
		}
		const pushPass = async (heartbeat: () => boolean) => {
			const freshDirty = await syncDb.bookmarks
				.filter((row) => row.dirty === 1)
				.toArray();
			for (const l of freshDirty) {
				// An abandoned pass must not replay its stale snapshot against
				// the fresh generation's pushes.
				if (!heartbeat()) {
					return;
				}
				try {
					if (l.deletedAt) {
						if (l.convexId) {
							await deleteRemote({ bookmarkId: l.convexId as never });
							await syncDb.bookmarks.delete(l.clientKey);
						}
						// No convexId: an unacknowledged create — the merge pass settles
						// it once the server list confirms whether it landed.
						continue;
					}
					const id = await createRemote({
						bookId: bookId as never,
						sectionIndex: l.sectionIndex,
						blockIndex: l.blockIndex,
						offset: l.offset,
						label: l.label,
						clientKey: l.clientKey,
						createdAt: l.createdAt,
					});
					await syncDb.bookmarks
						.where("clientKey")
						.equals(l.clientKey)
						.modify((row) => {
							row.convexId = id as unknown as string;
							// A delete may have landed during createRemote. Preserve its
							// dirty tombstone so the next queued pass deletes the server row.
							if (!row.deletedAt) {
								row.dirty = 0;
							}
						});
					settleSync();
				} catch {
					// Offline or transient — retried on the next change/reconnect.
					retrySync();
				}
			}
		};
		pushQueue.schedule(pushPass);
	}, [
		canQuery,
		localAll,
		bookId,
		createRemote,
		deleteRemote,
		syncWakeSignal,
		retrySync,
		settleSync,
		pushQueue,
	]);

	const createBookmark = useCallback(
		async (args: {
			sectionIndex: number;
			blockIndex: number;
			offset: number;
			label?: string;
		}) => {
			const clientKey = crypto.randomUUID();
			try {
				await syncDb.bookmarks.put({
					clientKey,
					bookId,
					sectionIndex: args.sectionIndex,
					blockIndex: args.blockIndex,
					offset: args.offset,
					label: args.label,
					createdAt: Date.now(),
					dirty: 1,
				});
				return clientKey;
			} catch {
				// IndexedDB unavailable — nothing durable to write.
				return null;
			}
		},
		[bookId],
	);

	const deleteBookmark = useCallback(async (clientKey: string) => {
		try {
			const row = await syncDb.bookmarks.get(clientKey);
			if (!row) {
				return false;
			}
			// Tombstone locally; the push effect propagates it. (Rows the server
			// never saw are settled by the merge pass.)
			await syncDb.bookmarks.update(clientKey, {
				deletedAt: Date.now(),
				dirty: 1,
			});
			return true;
		} catch {
			// IndexedDB unavailable.
			return false;
		}
	}, []);

	return { bookmarks, createBookmark, deleteBookmark };
}
