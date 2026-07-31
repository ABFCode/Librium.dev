import { describe, expect, test } from "vitest";
import {
	cleanDeviceId,
	nextServerVersion,
	observedServerVersion,
	rejectsStaleBase,
} from "../../convex/syncVersion";

describe("sync version primitives", () => {
	test("advances strictly when multiple writes share one millisecond", () => {
		expect(nextServerVersion(100, 100)).toBe(101);
		expect(nextServerVersion(101, 100)).toBe(102);
	});

	test("uses server time when it is safely ahead", () => {
		expect(nextServerVersion(100, 150)).toBe(150);
	});

	test("treats a missing client base as an unobserved version", () => {
		expect(observedServerVersion(undefined)).toBe(0);
	});
});

describe("device-aware stale-base rule", () => {
	test("a current base never rejects, regardless of devices", () => {
		expect(
			rejectsStaleBase({
				baseServerTime: 100,
				currentServerTime: 100,
				currentWriterDeviceId: "other",
				requestDeviceId: "mine",
			}),
		).toBe(false);
	});

	test("a stale base from another device rejects", () => {
		expect(
			rejectsStaleBase({
				baseServerTime: 50,
				currentServerTime: 100,
				currentWriterDeviceId: "other",
				requestDeviceId: "mine",
			}),
		).toBe(true);
	});

	test("a stale base from the device that authored the current value is accepted", () => {
		// Its own earlier write with a lost acknowledgement — causally ordered,
		// never a conflict.
		expect(
			rejectsStaleBase({
				baseServerTime: 50,
				currentServerTime: 100,
				currentWriterDeviceId: "mine",
				requestDeviceId: "mine",
			}),
		).toBe(false);
	});

	test("missing either device id falls back to strict rejection", () => {
		expect(
			rejectsStaleBase({
				baseServerTime: 50,
				currentServerTime: 100,
				currentWriterDeviceId: undefined,
				requestDeviceId: "mine",
			}),
		).toBe(true);
		expect(
			rejectsStaleBase({
				baseServerTime: 50,
				currentServerTime: 100,
				currentWriterDeviceId: "mine",
				requestDeviceId: undefined,
			}),
		).toBe(true);
	});

	test("cleanDeviceId strips blanks and caps length", () => {
		expect(cleanDeviceId("  ")).toBeUndefined();
		expect(cleanDeviceId(undefined)).toBeUndefined();
		expect(cleanDeviceId(`x${"y".repeat(100)}`)).toHaveLength(64);
	});
});
