/**
 * Per-record sync versions must advance strictly even when two Convex
 * mutations run inside the same wall-clock millisecond. Device clocks never
 * participate; `now` is injectable only for deterministic tests.
 */
export const nextServerVersion = (current: number, now = Date.now()) =>
	Math.max(now, current + 1);

/** Missing bases come from old/stale clients and are the oldest possible view. */
export const observedServerVersion = (base: number | undefined) => base ?? 0;

/** Normalizes a client-supplied installation id; blank/whitespace = absent. */
export const cleanDeviceId = (deviceId: string | undefined) => {
	const cleaned = deviceId?.trim().slice(0, 64);
	return cleaned || undefined;
};

/**
 * Device-aware optimistic concurrency for versioned LWW records.
 *
 * A write whose base predates the current server version is a conflict ONLY
 * when the current value was authored by a different device. When the same
 * device authored it, the "conflict" is that device's own earlier write whose
 * acknowledgement was lost (frozen tab, dead websocket, reload mid-flight) —
 * its local state is causally after that write by construction, so rejecting
 * would let a device's own echo roll back its newer edit. Accepting keeps
 * per-device writes monotone; genuine cross-device conflicts still reject and
 * the client adopts the echoed server state.
 *
 * Both ids must be present to prove same-device; missing either falls back to
 * the plain version comparison (old clients, pre-migration rows).
 */
export const rejectsStaleBase = (args: {
	baseServerTime: number | undefined;
	currentServerTime: number;
	currentWriterDeviceId: string | undefined;
	requestDeviceId: string | undefined;
}): boolean => {
	if (observedServerVersion(args.baseServerTime) >= args.currentServerTime) {
		return false;
	}
	return (
		args.requestDeviceId === undefined ||
		args.currentWriterDeviceId === undefined ||
		args.currentWriterDeviceId !== args.requestDeviceId
	);
};
