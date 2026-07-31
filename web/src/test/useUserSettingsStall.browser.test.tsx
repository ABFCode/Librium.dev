import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "vitest-browser-react";
import { useUserSettings } from "../hooks/useUserSettings";
import type { ReaderSettingField } from "../lib/db";
import { db } from "../lib/db";

// Wedged-push recovery and late-settlement safety for field-wise settings
// sync: an abandoned push that applied server-side must not roll back a newer
// edit (device-aware server acceptance), a stale acknowledgement must never
// settle a newer re-edit (per-field edit stamps), and accepted-but-normalized
// values must be adopted rather than looping.

const mocks = vi.hoisted(() => ({
	saveSettings: vi.fn(),
	STALL_MS: 150,
}));

vi.mock("convex/react", () => ({
	useConvexAuth: () => ({ isAuthenticated: true }),
	useQuery: () => undefined,
	useMutation: () => mocks.saveSettings,
}));

vi.mock("../lib/syncPushQueue", async (importOriginal) => {
	const mod = await importOriginal<typeof import("../lib/syncPushQueue")>();
	class TestSyncPushQueue extends mod.SyncPushQueue {
		constructor(_stallTimeoutMs?: number, onStallAbandon?: () => void) {
			super(mocks.STALL_MS, onStallAbandon);
		}
	}
	return { ...mod, SyncPushQueue: TestSyncPushQueue };
});

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const wake = () => window.dispatchEvent(new Event("focus"));

const baseSettings = {
	fontScale: 0,
	lineHeight: 1.7,
	contentWidth: 720,
	theme: "night",
	fontFamily: "sans",
};

const versions = (value: number): Record<ReaderSettingField, number> => ({
	fontScale: value,
	lineHeight: value,
	contentWidth: value,
	theme: value,
	fontFamily: value,
});

type SaveResult = {
	serverVersions: Record<ReaderSettingField, number>;
	settings: typeof baseSettings;
};

beforeEach(async () => {
	await db.settings.clear();
	mocks.saveSettings.mockReset();
	localStorage.clear();
	Object.defineProperty(window.navigator, "onLine", {
		configurable: true,
		value: true,
	});
});

describe("useUserSettings wedged push recovery", () => {
	it("an abandoned push that applied server-side cannot roll back a newer edit", async () => {
		// Push A (theme "paper") applies at version 1 but its acknowledgement
		// never arrives. The fresh pass re-pushes the newer "sepia" with A's
		// old base; the device-aware server accepts it (same device), so the
		// newer edit survives.
		let resolveFirst: (value: SaveResult) => void = () => {};
		mocks.saveSettings
			.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						resolveFirst = resolve;
					}),
			)
			.mockImplementation(() =>
				Promise.resolve({
					serverVersions: { ...versions(1), theme: 2 },
					settings: { ...baseSettings, theme: "sepia" },
				}),
			);
		const { result, act } = await renderHook(() => useUserSettings());
		await act(() => {
			result.current.setTheme("paper");
		});
		await expect.poll(() => mocks.saveSettings.mock.calls.length).toBe(1);
		await act(() => {
			result.current.setTheme("sepia");
		});

		await wait(mocks.STALL_MS + 50);
		wake();
		await expect
			.poll(async () => (await db.settings.get("reader"))?.dirtyFields.length)
			.toBe(0);
		const repush = mocks.saveSettings.mock.calls[1]?.[0] as {
			theme: string;
			deviceId?: string;
			baseVersions: Record<string, number>;
		};
		expect(repush).toEqual(
			expect.objectContaining({
				theme: "sepia",
				baseVersions: expect.objectContaining({ theme: 0 }),
			}),
		);
		expect(typeof repush.deviceId).toBe("string");

		// The original acknowledgement finally arrives: it is for an older
		// edit, so it must neither change the value nor wind the version back.
		resolveFirst({
			serverVersions: versions(1),
			settings: { ...baseSettings, theme: "paper" },
		});
		await wait(50);
		const final = await db.settings.get("reader");
		expect(final?.theme).toBe("sepia");
		expect(final?.syncedServerTimes.theme).toBe(2);
		expect(final?.dirtyFields).toEqual([]);
	});

	it("a late acknowledgement cannot settle a newer re-edit to the same value", async () => {
		// Value equality is not causality: the user sets "paper", then
		// "night", then "paper" again while the first push's acknowledgement
		// is still in flight. When that stale acknowledgement lands, the
		// row's value equals what was sent — but the newest edit has never
		// pushed. Clearing dirty on it would strand the edit locally forever.
		let resolveFirst: (value: SaveResult) => void = () => {};
		mocks.saveSettings
			.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						resolveFirst = resolve;
					}),
			)
			.mockImplementation(() =>
				Promise.resolve({
					serverVersions: { ...versions(1), theme: 2 },
					settings: { ...baseSettings, theme: "paper" },
				}),
			);
		const { result, act } = await renderHook(() => useUserSettings());
		await act(() => {
			result.current.setTheme("paper");
		});
		await expect.poll(() => mocks.saveSettings.mock.calls.length).toBe(1);

		// Re-edit away and back before the first acknowledgement arrives.
		await act(() => {
			result.current.setTheme("night");
		});
		await act(() => {
			result.current.setTheme("paper");
		});
		resolveFirst({
			serverVersions: versions(1),
			settings: { ...baseSettings, theme: "paper" },
		});
		await wait(50);
		// The stale acknowledgement must not settle the newer re-edit.
		expect((await db.settings.get("reader"))?.dirtyFields).toEqual(["theme"]);

		// The newer re-edit still pushes and settles.
		await expect
			.poll(() => mocks.saveSettings.mock.calls.length)
			.toBeGreaterThan(1);
		await expect
			.poll(async () => (await db.settings.get("reader"))?.dirtyFields.length)
			.toBe(0);
		const final = await db.settings.get("reader");
		expect(final?.theme).toBe("paper");
		expect(final?.syncedServerTimes.theme).toBe(2);
	});

	it("adopts an accepted-but-normalized value instead of re-pushing forever", async () => {
		// The server clamps/whitelists on accept. An acceptance that echoes a
		// normalized value different from what was sent must be adopted and
		// settled — re-pushing the raw value would loop forever.
		mocks.saveSettings.mockImplementation(() =>
			Promise.resolve({
				serverVersions: { ...versions(0), theme: 1 },
				settings: { ...baseSettings, theme: "night" },
			}),
		);
		const { result, act } = await renderHook(() => useUserSettings());
		await act(() => {
			result.current.setTheme("day"); // unknown theme → normalized to night
		});
		await expect
			.poll(async () => (await db.settings.get("reader"))?.dirtyFields.length)
			.toBe(0);
		const row = await db.settings.get("reader");
		expect(row?.theme).toBe("night");
		expect(row?.syncedServerTimes.theme).toBe(1);
		// Converged in a single round-trip; no retry loop.
		await wait(400);
		expect(mocks.saveSettings).toHaveBeenCalledTimes(1);
	});
});
