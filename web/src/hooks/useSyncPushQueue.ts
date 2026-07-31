import { useRef } from "react";
import { SyncPushQueue } from "../lib/syncPushQueue";

// One serialized push queue per hook instance (see SyncPushQueue for the
// stall/abandonment contract). onStallAbandon should be the stable retry()
// from useSyncWakeSignal: when the stall timer abandons a wedged pass, the
// armed wake re-runs the push effect so a fresh pass follows even if no edit
// or browser event ever fires.
export function useSyncPushQueue(onStallAbandon: () => void): SyncPushQueue {
	const queueRef = useRef<SyncPushQueue | null>(null);
	queueRef.current ??= new SyncPushQueue(undefined, onStallAbandon);
	return queueRef.current;
}
