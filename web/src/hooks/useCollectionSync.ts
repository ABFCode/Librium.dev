import { useMutation, useQuery } from "convex/react";
import { useLiveQuery } from "dexie-react-hooks";
import { useCallback, useEffect, useMemo } from "react";
import { api } from "../../convex/_generated/api";
import { db, type LocalCollection } from "../lib/db";
import { getSyncDeviceInfo } from "../lib/syncDevice";
import { useSyncPushQueue } from "./useSyncPushQueue";
import { useSyncWakeSignal } from "./useSyncWakeSignal";

// Local-first collections + memberships with tombstone sync — two instances
// of the bookmark pattern, plus one ordering rule of their own:
//
// Memberships reference their collection by *client* key, so books can be
// added to a collection that was created offline and has no Convex id yet.
// The push pass therefore sends dirty collections first and skips any
// membership whose collection still lacks a convexId — the collection's
// create backfills it (same run or a later one), and the membership goes on
// the next pass.
//
// Two-device walkthrough: device A offline-creates collection C and adds 3
// books. On reconnect, A pushes C (idempotent on clientKey), records C's
// convexId, then pushes the memberships against it. Device B's merge adopts
// C by clientKey and resolves the memberships' collectionId back to C's
// clientKey. If B had deleted C meanwhile, the server add returns null
// (tombstoned collection) and A's merge purges its local rows.

type UseCollectionSyncArgs = {
	canQuery: boolean;
};

export function useCollectionSync({ canQuery }: UseCollectionSyncArgs) {
	const syncDb = db;
	const createRemote = useMutation(api.collections.createCollection);
	const renameRemote = useMutation(api.collections.renameCollection);
	const deleteRemote = useMutation(api.collections.deleteCollection);
	const addRemote = useMutation(api.collections.addBookMembership);
	const removeRemote = useMutation(api.collections.removeBookMembership);
	const {
		signal: syncWakeSignal,
		retry: retrySync,
		settled: settleSync,
	} = useSyncWakeSignal();

	const remoteCollections = useQuery(
		api.collections.listByUser,
		canQuery ? {} : "skip",
	);
	const remoteMemberships = useQuery(
		api.collections.listMembershipsByUser,
		canQuery ? {} : "skip",
	);
	const localCollections = useLiveQuery(() => syncDb.collections.toArray(), []);
	const localMemberships = useLiveQuery(
		() => syncDb.collectionBooks.toArray(),
		[],
	);

	// ── Merge: collections ───────────────────────────────────────────────────
	useEffect(() => {
		if (!remoteCollections || localCollections === undefined) {
			return;
		}
		void (async () => {
			const byConvexId = new Map(
				localCollections.flatMap((l) =>
					l.convexId ? [[l.convexId, l] as const] : [],
				),
			);
			const byClientKey = new Map(
				localCollections.map((l) => [l.clientKey, l]),
			);
			const remoteIds = new Set<string>();
			for (const r of remoteCollections) {
				remoteIds.add(r._id as string);
				const local =
					byConvexId.get(r._id as string) ?? byClientKey.get(r.clientKey);
				try {
					if (r.deletedAt) {
						// Remote tombstone: drop the local collection and any local
						// membership rows still pointing at it.
						const key = local?.clientKey ?? r.clientKey;
						await syncDb.collections.delete(key);
						await syncDb.collectionBooks
							.where("collectionKey")
							.equals(key)
							.delete();
						continue;
					}
					if (!local) {
						await syncDb.collections.put({
							clientKey: r.clientKey,
							name: r.name,
							createdAt: r.createdAt,
							nameEditedAt: r.nameEditedAt ?? 0,
							syncedServerTime: r.nameUpdatedAt ?? r.updatedAt,
							dirty: 0,
							convexId: r._id as string,
						});
						continue;
					}
					if (!local.convexId) {
						// Our offline create landed — record the id. Re-read the live
						// row: a rename/delete committed after this pass's snapshot
						// leaves dirty set, and must survive.
						await syncDb.collections
							.where("clientKey")
							.equals(local.clientKey)
							.modify((row) => {
								row.convexId = r._id as string;
								row.syncedServerTime = r.nameUpdatedAt ?? r.updatedAt;
								if (!row.deletedAt && row.nameEditedAt <= local.nameEditedAt) {
									row.dirty = 0;
								}
							});
						continue;
					}
					const remoteNameUpdatedAt = r.nameUpdatedAt ?? r.updatedAt;
					if (
						!local.dirty &&
						remoteNameUpdatedAt > (local.syncedServerTime ?? 0)
					) {
						// Rename made elsewhere; adopt it — but re-check the live row so a
						// local rename that raced in after the snapshot (LWW: newer) wins.
						const remoteName = r.name;
						const remoteNameEditedAt = r.nameEditedAt ?? 0;
						await syncDb.collections
							.where("clientKey")
							.equals(local.clientKey)
							.modify((row) => {
								if (
									row.dirty ||
									remoteNameUpdatedAt <= (row.syncedServerTime ?? 0)
								) {
									return;
								}
								row.name = remoteName;
								row.nameEditedAt = remoteNameEditedAt;
								row.syncedServerTime = remoteNameUpdatedAt;
							});
					}
				} catch {
					// IndexedDB hiccup — retried on the next merge.
				}
			}
			for (const l of localCollections) {
				try {
					if (l.convexId && !remoteIds.has(l.convexId)) {
						await syncDb.collections.delete(l.clientKey);
						await syncDb.collectionBooks
							.where("collectionKey")
							.equals(l.clientKey)
							.delete();
					} else if (!l.convexId && l.deletedAt) {
						const landed = remoteCollections.some(
							(r) => r.clientKey === l.clientKey,
						);
						if (!landed) {
							await syncDb.collections.delete(l.clientKey);
							await syncDb.collectionBooks
								.where("collectionKey")
								.equals(l.clientKey)
								.delete();
						}
					}
				} catch {
					// Retried on the next merge.
				}
			}
		})();
	}, [remoteCollections, localCollections]);

	// ── Merge: memberships ───────────────────────────────────────────────────
	useEffect(() => {
		if (
			!remoteMemberships ||
			localMemberships === undefined ||
			localCollections === undefined
		) {
			return;
		}
		void (async () => {
			const collectionKeyByConvexId = new Map(
				localCollections.flatMap((c) =>
					c.convexId ? [[c.convexId, c.clientKey] as const] : [],
				),
			);
			const byConvexId = new Map(
				localMemberships.flatMap((l) =>
					l.convexId ? [[l.convexId, l] as const] : [],
				),
			);
			const byClientKey = new Map(
				localMemberships.map((l) => [l.clientKey, l]),
			);
			const remoteIds = new Set<string>();
			for (const r of remoteMemberships) {
				remoteIds.add(r._id as string);
				const local =
					byConvexId.get(r._id as string) ?? byClientKey.get(r.clientKey);
				try {
					if (r.deletedAt) {
						if (!local) {
							const collectionKey = collectionKeyByConvexId.get(
								r.collectionId as string,
							);
							if (collectionKey) {
								await syncDb.collectionBooks.put({
									clientKey: r.clientKey,
									collectionKey,
									bookId: r.bookId as string,
									createdAt: r.createdAt,
									editedAt: r.updatedAt,
									syncedServerTime: r.updatedAt,
									deletedAt: r.deletedAt,
									dirty: 0,
									convexId: r._id as string,
								});
							}
						} else if (!local.dirty) {
							await syncDb.collectionBooks
								.where("clientKey")
								.equals(local.clientKey)
								.modify((row) => {
									if (row.dirty) return;
									row.convexId = r._id as string;
									row.syncedServerTime = r.updatedAt;
									row.editedAt = r.updatedAt;
									row.deletedAt = r.deletedAt;
									row.dirty = 0;
								});
						}
						continue;
					}
					if (!local) {
						const collectionKey = collectionKeyByConvexId.get(
							r.collectionId as string,
						);
						if (!collectionKey) {
							// The collection row hasn't merged yet — next pass catches it.
							continue;
						}
						await syncDb.collectionBooks.put({
							clientKey: r.clientKey,
							collectionKey,
							bookId: r.bookId as string,
							createdAt: r.createdAt,
							editedAt: r.updatedAt,
							syncedServerTime: r.updatedAt,
							dirty: 0,
							convexId: r._id as string,
						});
						continue;
					}
					if (!local.convexId) {
						// Re-read the live row: a remove committed after the snapshot
						// sets deletedAt+dirty and must survive to be pushed.
						await syncDb.collectionBooks
							.where("clientKey")
							.equals(local.clientKey)
							.modify((row) => {
								row.convexId = r._id as string;
								row.syncedServerTime = Math.max(
									row.syncedServerTime ?? 0,
									r.updatedAt,
								);
								if (
									!row.deletedAt &&
									(row.editedAt ?? row.createdAt) <=
										(local.editedAt ?? local.createdAt)
								) {
									row.dirty = 0;
								}
							});
					} else if (
						!local.dirty &&
						r.updatedAt > (local.syncedServerTime ?? 0)
					) {
						await syncDb.collectionBooks
							.where("clientKey")
							.equals(local.clientKey)
							.modify((row) => {
								if (row.dirty || r.updatedAt <= (row.syncedServerTime ?? 0)) {
									return;
								}
								row.deletedAt = undefined;
								row.editedAt = r.updatedAt;
								row.syncedServerTime = r.updatedAt;
								row.dirty = 0;
							});
					}
				} catch {
					// Retried on the next merge.
				}
			}
			for (const l of localMemberships) {
				try {
					if (l.convexId && !remoteIds.has(l.convexId)) {
						await syncDb.collectionBooks.delete(l.clientKey);
					} else if (!l.convexId && l.deletedAt && l.dirty) {
						const landed = remoteMemberships.some(
							(r) => r.clientKey === l.clientKey,
						);
						if (!landed) {
							await syncDb.collectionBooks.delete(l.clientKey);
						}
					}
				} catch {
					// Retried on the next merge.
				}
			}
		})();
	}, [remoteMemberships, localMemberships, localCollections]);

	// ── Push (collections first, then memberships) ───────────────────────────
	// Passes serialize on a SyncPushQueue: a liveQuery emission landing while a
	// pass is in flight enqueues another pass instead of being dropped (a
	// dropped emission would strand dirty rows until the next unrelated edit).
	// Each pass re-reads dirty rows from Dexie so it always sees fresh state,
	// and the queue abandons a pass wedged on a never-settling mutation. A
	// rejection is always a genuine foreign conflict (the server accepts
	// same-device stale bases), so adopting the echo is correct.
	const syncDevice = useMemo(() => getSyncDeviceInfo(), []);
	const pushQueue = useSyncPushQueue(retrySync);
	useEffect(() => {
		void syncWakeSignal; // reconnect/backoff trigger; durable rows are re-read below
		if (
			!canQuery ||
			localCollections === undefined ||
			localMemberships === undefined
		) {
			return;
		}
		const hasDirty =
			localCollections.some((l) => l.dirty) ||
			localMemberships.some((l) => l.dirty);
		if (!hasDirty) {
			return;
		}
		const pushPass = async (heartbeat: () => boolean) => {
			const dirtyCollections = await syncDb.collections
				.filter((l) => l.dirty === 1)
				.toArray();
			const dirtyMemberships = await syncDb.collectionBooks
				.filter((l) => l.dirty === 1)
				.toArray();
			// convexIds recorded during this run, so memberships of a
			// just-created collection can push in the same pass.
			const freshConvexIds = new Map<string, string>();
			for (const l of dirtyCollections) {
				// An abandoned pass must not replay its stale snapshot against
				// the fresh generation's pushes.
				if (!heartbeat()) {
					return;
				}
				try {
					if (l.deletedAt) {
						if (l.convexId) {
							await deleteRemote({ collectionId: l.convexId as never });
							await syncDb.collections.delete(l.clientKey);
							await syncDb.collectionBooks
								.where("collectionKey")
								.equals(l.clientKey)
								.delete();
						}
						// No convexId: unacknowledged create — merge settles it.
						continue;
					}
					if (!l.convexId) {
						const created = await createRemote({
							name: l.name,
							clientKey: l.clientKey,
							createdAt: l.createdAt,
						});
						// An idempotent-match returns the existing row without renaming;
						// follow up when a rename happened after the create.
						let acceptedServerTime = created.serverTime;
						let rejectedName: string | undefined;
						if (l.nameEditedAt > l.createdAt) {
							const renamed = await renameRemote({
								collectionId: created.id as never,
								name: l.name,
								baseServerTime: created.serverTime,
								deviceId: syncDevice.id,
							});
							if (renamed) {
								acceptedServerTime = renamed.serverTime;
								if (!renamed.accepted) {
									rejectedName = renamed.name;
								}
							}
						}
						freshConvexIds.set(l.clientKey, created.id as unknown as string);
						await syncDb.collections
							.where("clientKey")
							.equals(l.clientKey)
							.modify((row) => {
								row.convexId = created.id as unknown as string;
								row.syncedServerTime = Math.max(
									row.syncedServerTime ?? 0,
									acceptedServerTime,
								);
								if (row.nameEditedAt <= l.nameEditedAt && !row.deletedAt) {
									if (rejectedName !== undefined) {
										row.name = rejectedName;
										row.nameEditedAt = acceptedServerTime;
									}
									row.dirty = 0;
								}
							});
						settleSync();
						continue;
					}
					const editedAt = l.nameEditedAt;
					const renamed = await renameRemote({
						collectionId: l.convexId as never,
						name: l.name,
						baseServerTime: l.syncedServerTime ?? 0,
						deviceId: syncDevice.id,
					});
					await syncDb.collections
						.where("clientKey")
						.equals(l.clientKey)
						.modify((row) => {
							if (!renamed) {
								return;
							}
							row.syncedServerTime = Math.max(
								row.syncedServerTime ?? 0,
								renamed.serverTime,
							);
							// Only clear dirty if no newer local edit happened meanwhile.
							if (row.nameEditedAt <= editedAt && !row.deletedAt) {
								if (!renamed.accepted) {
									row.name = renamed.name;
									row.nameEditedAt = renamed.serverTime;
								}
								row.dirty = 0;
							}
						});
					settleSync();
				} catch {
					// Offline or transient — retried on the next change/reconnect.
					retrySync();
				}
			}
			const collectionsByKey = new Map(
				(await syncDb.collections.toArray()).map((c) => [c.clientKey, c]),
			);
			for (const l of dirtyMemberships) {
				// An abandoned pass must not replay its stale snapshot against
				// the fresh generation's pushes.
				if (!heartbeat()) {
					return;
				}
				const sentEditedAt = l.editedAt ?? l.createdAt;
				try {
					if (l.deletedAt) {
						if (l.convexId) {
							const removed = await removeRemote({
								membershipId: l.convexId as never,
								baseServerTime: l.syncedServerTime ?? 0,
								deviceId: syncDevice.id,
							});
							const outcome = removed ?? {
								serverTime: l.syncedServerTime ?? 0,
								deleted: true,
							};
							await syncDb.collectionBooks
								.where("clientKey")
								.equals(l.clientKey)
								.modify((row) => {
									row.syncedServerTime = Math.max(
										row.syncedServerTime ?? 0,
										outcome.serverTime,
									);
									if ((row.editedAt ?? row.createdAt) <= sentEditedAt) {
										row.deletedAt = outcome.deleted
											? (row.deletedAt ?? Date.now())
											: undefined;
										row.dirty = 0;
									}
								});
							settleSync();
						}
						continue;
					}
					const collectionConvexId =
						freshConvexIds.get(l.collectionKey) ??
						collectionsByKey.get(l.collectionKey)?.convexId;
					if (!collectionConvexId) {
						// Collection create not acknowledged yet — see ordering note in
						// the header comment; retried next pass.
						continue;
					}
					const added = await addRemote({
						collectionId: collectionConvexId as never,
						bookId: l.bookId as never,
						clientKey: l.clientKey,
						createdAt: l.createdAt,
						baseServerTime: l.syncedServerTime ?? 0,
						deviceId: syncDevice.id,
					});
					if (added === null) {
						// Collection was deleted elsewhere while this add was queued.
						await syncDb.collectionBooks.delete(l.clientKey);
						continue;
					}
					// Re-read the live row: a remove committed during the addRemote
					// round-trip set deletedAt+dirty; clearing dirty here would strand
					// the tombstone (never pushed, hidden locally, alive on the server).
					await syncDb.collectionBooks
						.where("clientKey")
						.equals(l.clientKey)
						.modify((row) => {
							row.convexId = added.id as unknown as string;
							row.syncedServerTime = Math.max(
								row.syncedServerTime ?? 0,
								added.serverTime,
							);
							if ((row.editedAt ?? row.createdAt) <= sentEditedAt) {
								row.deletedAt = added.deleted
									? (row.deletedAt ?? Date.now())
									: undefined;
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
		localCollections,
		localMemberships,
		createRemote,
		renameRemote,
		deleteRemote,
		addRemote,
		removeRemote,
		syncDevice,
		syncWakeSignal,
		retrySync,
		settleSync,
		pushQueue,
	]);

	// ── UI views ─────────────────────────────────────────────────────────────

	const collections: LocalCollection[] | undefined = useMemo(() => {
		if (localCollections === undefined) {
			return undefined;
		}
		return localCollections
			.filter((c) => !c.deletedAt)
			.sort((a, b) => a.name.localeCompare(b.name));
	}, [localCollections]);

	const membershipsByBook = useMemo(() => {
		const map = new Map<string, Set<string>>();
		for (const m of localMemberships ?? []) {
			if (m.deletedAt) {
				continue;
			}
			let set = map.get(m.bookId);
			if (!set) {
				set = new Set();
				map.set(m.bookId, set);
			}
			set.add(m.collectionKey);
		}
		return map;
	}, [localMemberships]);

	const createCollection = useCallback(async (name: string) => {
		const clientKey = crypto.randomUUID();
		const now = Date.now();
		try {
			await syncDb.collections.put({
				clientKey,
				name: name.trim(),
				createdAt: now,
				nameEditedAt: now,
				syncedServerTime: 0,
				dirty: 1,
			});
		} catch {
			// IndexedDB unavailable — nothing durable to write.
		}
		return clientKey;
	}, []);

	const renameCollection = useCallback(
		async (clientKey: string, name: string) => {
			try {
				await syncDb.collections
					.where("clientKey")
					.equals(clientKey)
					.modify((row) => {
						row.name = name.trim();
						row.nameEditedAt = Math.max(Date.now(), row.nameEditedAt + 1);
						row.dirty = 1;
					});
			} catch {
				// IndexedDB unavailable.
			}
		},
		[],
	);

	const deleteCollection = useCallback(async (clientKey: string) => {
		const now = Date.now();
		try {
			await syncDb.collections.update(clientKey, {
				deletedAt: now,
				dirty: 1,
			});
			// Tombstone the memberships too so the UI empties immediately; the
			// server cascade (and merge settling for offline-only rows) finishes
			// the job.
			await syncDb.collectionBooks
				.where("collectionKey")
				.equals(clientKey)
				.modify((row) => {
					row.deletedAt = now;
					row.dirty = 1;
				});
		} catch {
			// IndexedDB unavailable.
		}
	}, []);

	const addBooks = useCallback(
		async (collectionKey: string, bookIds: string[]) => {
			try {
				const existing = await syncDb.collectionBooks
					.where("collectionKey")
					.equals(collectionKey)
					.toArray();
				const live = new Set(
					existing.filter((m) => !m.deletedAt).map((m) => m.bookId),
				);
				const now = Date.now();
				for (const bookId of bookIds) {
					if (live.has(bookId)) {
						continue;
					}
					const tombstone = existing.find(
						(row) => row.bookId === bookId && row.deletedAt,
					);
					if (tombstone) {
						await syncDb.collectionBooks.update(tombstone.clientKey, {
							deletedAt: undefined,
							editedAt: Math.max(
								now,
								(tombstone.editedAt ?? tombstone.createdAt) + 1,
							),
							dirty: 1,
						});
						continue;
					}
					// Always a fresh clientKey: resurrecting a tombstoned key is unsafe
					// (the server may already hold its tombstone).
					await syncDb.collectionBooks.put({
						clientKey: crypto.randomUUID(),
						collectionKey,
						bookId,
						createdAt: now,
						editedAt: now,
						syncedServerTime: 0,
						dirty: 1,
					});
				}
			} catch {
				// IndexedDB unavailable.
			}
		},
		[],
	);

	const removeBooks = useCallback(
		async (collectionKey: string, bookIds: string[]) => {
			try {
				const targets = new Set(bookIds);
				await syncDb.collectionBooks
					.where("collectionKey")
					.equals(collectionKey)
					.modify((row) => {
						if (!row.deletedAt && targets.has(row.bookId)) {
							const now = Math.max(
								Date.now(),
								(row.editedAt ?? row.createdAt) + 1,
							);
							row.editedAt = now;
							row.deletedAt = now;
							row.dirty = 1;
						}
					});
			} catch {
				// IndexedDB unavailable.
			}
		},
		[],
	);

	return {
		collections,
		membershipsByBook,
		createCollection,
		renameCollection,
		deleteCollection,
		addBooks,
		removeBooks,
	};
}
