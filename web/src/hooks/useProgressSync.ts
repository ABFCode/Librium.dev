import { useMutation, useQuery } from "convex/react";
import { useLiveQuery } from "dexie-react-hooks";
import { useCallback, useEffect, useMemo } from "react";
import { api } from "../../convex/_generated/api";
import { db, type LocalProgress } from "../lib/db";
import { getSyncDeviceInfo } from "../lib/syncDevice";
import { useSyncPushQueue } from "./useSyncPushQueue";
import { useSyncWakeSignal } from "./useSyncWakeSignal";

// Local-first reading progress with LWW sync (ROADMAP Phase 4).
//
// Rules (see ROADMAP.md "Sync design"):
// - Every edit is written to IndexedDB first (instant, offline-capable) and
//   marked dirty.
// - Dirty records push with the last server version this device merged. The
//   server rejects a write based on older state, without consulting clocks.
// - Pull ordering never compares device clocks against the server clock: a
//   remote record is adopted only if its server updatedAt is newer than the
//   last server state this device merged (syncedServerTime) — and never over
//   unpushed local edits.

export type EffectiveProgress = {
	sectionIndex: number;
	blockIndex: number;
	blockOffset: number;
	sectionFraction: number;
	source: "local" | "remote";
};

type UseProgressSyncArgs = {
	bookId: string;
	canQuery: boolean;
};

export function useProgressSync({ bookId, canQuery }: UseProgressSyncArgs) {
	// Pin this hook to the account database it mounted with. The exported `db`
	// binding changes on account switch; an old in-flight response must never
	// acknowledge or merge into the next account's database.
	const syncDb = db;
	const syncDevice = useMemo(() => getSyncDeviceInfo(), []);
	const updateProgress = useMutation(api.userBooks.updateProgress);
	const {
		signal: syncWakeSignal,
		retry: retrySync,
		settled: settleSync,
	} = useSyncWakeSignal();
	const remote = useQuery(
		api.userBooks.getUserBook,
		canQuery ? { bookId: bookId as never } : "skip",
	);
	// undefined = still loading; null = no local record.
	const local = useLiveQuery(
		async () =>
			((await syncDb.progress.get(bookId)) ?? null) as LocalProgress | null,
		[bookId],
	);

	const remoteRecord: LocalProgress | null = useMemo(() => {
		if (!remote) {
			return null;
		}
		return {
			bookId,
			sectionIndex: remote.lastSectionIndex ?? 0,
			blockIndex: remote.lastBlockIndex ?? 0,
			blockOffset: remote.lastBlockOffset ?? 0,
			sectionFraction: remote.lastSectionFraction ?? 0,
			editedAt:
				remote.progressUpdatedAt ??
				(remote.progressEditedAt !== undefined ? remote.updatedAt : 0),
			dirty: 0,
			syncedServerTime:
				remote.progressUpdatedAt ??
				(remote.progressEditedAt !== undefined ? remote.updatedAt : 0),
		};
	}, [remote, bookId]);

	// The merged view the reader should restore from. Computed in memory so the
	// reader never waits on an IndexedDB round-trip after a remote merge.
	const effectiveProgress: EffectiveProgress | null | undefined =
		useMemo(() => {
			if (local === undefined) {
				return undefined;
			}
			if (canQuery && remote === undefined) {
				// Online with the remote copy still loading — brief wait, mirrors the
				// pre-existing "Restoring" gate. Offline (canQuery false) skips this.
				return undefined;
			}
			let pick: "local" | "remote" | null;
			if (!local) {
				pick = remoteRecord ? "remote" : null;
			} else if (local.dirty) {
				pick = "local";
			} else if (
				remoteRecord &&
				remoteRecord.syncedServerTime > local.syncedServerTime
			) {
				pick = "remote";
			} else {
				pick = "local";
			}
			if (pick === null) {
				return null;
			}
			const rec = pick === "remote" ? remoteRecord : local;
			if (!rec) {
				return null;
			}
			return {
				sectionIndex: rec.sectionIndex,
				blockIndex: rec.blockIndex,
				blockOffset: rec.blockOffset,
				sectionFraction: rec.sectionFraction ?? 0,
				source: pick,
			};
		}, [local, remoteRecord, remote, canQuery]);

	// Persist adopted remote state so it survives going offline.
	useEffect(() => {
		if (!remoteRecord || local === undefined) {
			return;
		}
		if (
			local &&
			(local.dirty || remoteRecord.syncedServerTime <= local.syncedServerTime)
		) {
			return;
		}
		void syncDb
			.transaction("rw", syncDb.progress, async () => {
				const live = await syncDb.progress.get(bookId);
				if (
					live?.dirty ||
					(live && remoteRecord.syncedServerTime <= live.syncedServerTime)
				) {
					return;
				}
				await syncDb.progress.put(remoteRecord);
			})
			.catch(() => {});
	}, [remoteRecord, local, bookId]);

	// Push dirty local edits to the server (fires on edit, on reconnect, and
	// after a stall abandonment via the queue's wake). An abandoned push that
	// applied unacknowledged is resolved server-side (same-device stale-base
	// acceptance — see SyncPushQueue), so a rejection here always means a
	// genuine foreign conflict and adopting the echo is correct.
	const pushQueue = useSyncPushQueue(retrySync);
	useEffect(() => {
		void syncWakeSignal; // reconnect/backoff trigger; durable row is re-read below
		if (!canQuery || !local?.dirty) {
			return;
		}
		const pushPass = async () => {
			const row = await syncDb.progress.get(bookId);
			if (!row?.dirty) {
				return;
			}
			const editedAt = row.editedAt;
			try {
				const result = await updateProgress({
					bookId: bookId as never,
					lastSectionIndex: row.sectionIndex,
					lastBlockIndex: row.blockIndex,
					lastBlockOffset: row.blockOffset,
					lastSectionFraction: row.sectionFraction ?? 0,
					baseServerTime: row.syncedServerTime,
					deviceId: syncDevice.id,
					deviceKind: syncDevice.kind,
				});
				await syncDb.progress
					.where("bookId")
					.equals(bookId)
					.modify((p) => {
						// A newer local edit is causally after this accepted write, so
						// rebase it onto the returned server version while keeping it dirty.
						// Accepted or rejected, this response proves the client has now
						// observed the returned server version. Rebase any newer local edit.
						p.syncedServerTime = Math.max(
							p.syncedServerTime,
							result.serverTime,
						);
						// Only clear dirty if no newer local edit happened meanwhile. A
						// rejection is a genuine foreign conflict (the server accepts
						// same-device stale bases), so adopting the echo is correct.
						if (p.editedAt <= editedAt) {
							if (!result.accepted) {
								p.sectionIndex = result.lastSectionIndex;
								p.blockIndex = result.lastBlockIndex ?? 0;
								p.blockOffset = result.lastBlockOffset ?? 0;
								p.sectionFraction = result.lastSectionFraction ?? 0;
								p.editedAt = result.serverTime;
							}
							p.dirty = 0;
						}
					});
				settleSync();
			} catch {
				// Offline or transient — retried on the next edit or reconnect.
				retrySync();
			}
		};
		pushQueue.schedule(pushPass);
	}, [
		canQuery,
		local,
		bookId,
		updateProgress,
		syncDevice,
		syncWakeSignal,
		retrySync,
		settleSync,
		pushQueue,
	]);

	const saveProgress = useCallback(
		async (args: {
			sectionIndex: number;
			blockIndex: number;
			blockOffset: number;
			sectionFraction?: number;
		}) => {
			try {
				const existing = await syncDb.progress.get(bookId);
				const sectionFraction = args.sectionFraction ?? 0;
				if (
					existing &&
					existing.syncedServerTime > 0 &&
					existing.sectionIndex === args.sectionIndex &&
					existing.blockIndex === args.blockIndex &&
					existing.blockOffset === args.blockOffset &&
					(existing.sectionFraction ?? 0) === sectionFraction
				) {
					return;
				}
				await syncDb.progress.put({
					bookId,
					sectionIndex: args.sectionIndex,
					blockIndex: args.blockIndex,
					blockOffset: args.blockOffset,
					sectionFraction,
					editedAt: Math.max(Date.now(), (existing?.editedAt ?? 0) + 1),
					dirty: 1,
					syncedServerTime: existing?.syncedServerTime ?? 0,
				});
			} catch {
				// IndexedDB unavailable — nothing durable to write.
			}
		},
		[bookId],
	);

	return { effectiveProgress, saveProgress };
}
