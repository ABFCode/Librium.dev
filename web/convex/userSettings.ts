import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { getViewerUserId, requireViewerUserId } from "./authHelpers";
import {
	cleanDeviceId,
	nextServerVersion,
	rejectsStaleBase,
} from "./syncVersion";

const fields = [
	"fontScale",
	"lineHeight",
	"contentWidth",
	"theme",
	"fontFamily",
] as const;
type SettingField = (typeof fields)[number];
type SettingsValues = {
	fontScale: number;
	lineHeight: number;
	contentWidth: number;
	theme: string;
	fontFamily: string;
};
type SettingsVersions = Record<SettingField, number>;
type SettingsAccepted = Record<SettingField, boolean>;

const defaults: SettingsValues = {
	fontScale: 0,
	lineHeight: 1.7,
	contentWidth: 720,
	theme: "night",
	fontFamily: "sans",
};

const versionKeys = {
	fontScale: "fontScaleUpdatedAt",
	lineHeight: "lineHeightUpdatedAt",
	contentWidth: "contentWidthUpdatedAt",
	theme: "themeUpdatedAt",
	fontFamily: "fontFamilyUpdatedAt",
} as const;

const clamp = (value: number, min: number, max: number) =>
	Math.min(Math.max(value, min), max);

const normalize = {
	fontScale: (value: number) => clamp(value, -2, 10),
	lineHeight: (value: number) => clamp(value, 1.4, 2.4),
	contentWidth: (value: number) => clamp(value, 520, 960),
	theme: (value: string) =>
		new Set(["night", "paper", "sepia"]).has(value) ? value : "night",
	fontFamily: (value: string) =>
		value === "serif" || value === "sans" ? value : "sans",
};

export const getByUser = query({
	args: {},
	handler: async (ctx) => {
		const userId = await getViewerUserId(ctx);
		if (!userId) {
			return null;
		}
		return await ctx.db
			.query("userSettings")
			.withIndex("by_user", (q) => q.eq("userId", userId))
			.first();
	},
});

export const upsert = mutation({
	args: {
		fontScale: v.optional(v.number()),
		lineHeight: v.optional(v.number()),
		contentWidth: v.optional(v.number()),
		theme: v.optional(v.string()),
		fontFamily: v.optional(v.string()),
		baseVersions: v.optional(
			v.object({
				fontScale: v.optional(v.number()),
				lineHeight: v.optional(v.number()),
				contentWidth: v.optional(v.number()),
				theme: v.optional(v.number()),
				fontFamily: v.optional(v.number()),
			}),
		),
		deviceId: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		const userId = await requireViewerUserId(ctx);
		const deviceId = cleanDeviceId(args.deviceId);
		const existing = await ctx.db
			.query("userSettings")
			.withIndex("by_user", (q) => q.eq("userId", userId))
			.first();

		if (!existing) {
			const now = nextServerVersion(0);
			const settings: SettingsValues = {
				fontScale: normalize.fontScale(args.fontScale ?? defaults.fontScale),
				lineHeight: normalize.lineHeight(
					args.lineHeight ?? defaults.lineHeight,
				),
				contentWidth: normalize.contentWidth(
					args.contentWidth ?? defaults.contentWidth,
				),
				theme: normalize.theme(args.theme ?? defaults.theme),
				fontFamily: normalize.fontFamily(
					args.fontFamily ?? defaults.fontFamily,
				),
			};
			const serverVersions = Object.fromEntries(
				fields.map((field) => [field, args[field] === undefined ? 0 : now]),
			) as SettingsVersions;
			const accepted = Object.fromEntries(
				fields.map((field) => [field, args[field] !== undefined]),
			) as SettingsAccepted;
			const fieldDeviceIds =
				deviceId === undefined
					? undefined
					: (Object.fromEntries(
							fields
								.filter((field) => args[field] !== undefined)
								.map((field) => [field, deviceId]),
						) as Partial<Record<SettingField, string>>);
			await ctx.db.insert("userSettings", {
				userId,
				...settings,
				fontScaleUpdatedAt: serverVersions.fontScale,
				lineHeightUpdatedAt: serverVersions.lineHeight,
				contentWidthUpdatedAt: serverVersions.contentWidth,
				themeUpdatedAt: serverVersions.theme,
				fontFamilyUpdatedAt: serverVersions.fontFamily,
				fieldDeviceIds,
				updatedAt: now,
			});
			return { accepted, serverVersions, settings };
		}

		const settings: SettingsValues = {
			fontScale: existing.fontScale,
			lineHeight: existing.lineHeight,
			contentWidth: existing.contentWidth,
			theme: existing.theme,
			fontFamily: existing.fontFamily ?? "sans",
		};
		const serverVersions = Object.fromEntries(
			fields.map((field) => [
				field,
				existing[versionKeys[field]] ?? existing.updatedAt,
			]),
		) as SettingsVersions;
		const accepted = Object.fromEntries(
			fields.map((field) => [field, false]),
		) as SettingsAccepted;
		const patch: Record<string, unknown> = {};
		const fieldDeviceIds: Partial<Record<SettingField, string>> = {
			...existing.fieldDeviceIds,
		};
		let deviceIdsChanged = false;

		const apply = <K extends SettingField>(
			field: K,
			value: SettingsValues[K] | undefined,
		) => {
			if (value === undefined) {
				return;
			}
			const currentVersion = serverVersions[field];
			if (
				rejectsStaleBase({
					baseServerTime: args.baseVersions?.[field],
					currentServerTime: currentVersion,
					currentWriterDeviceId: existing.fieldDeviceIds?.[field],
					requestDeviceId: deviceId,
				})
			) {
				return;
			}
			const normalized = normalize[field](value as never) as SettingsValues[K];
			const nextVersion = nextServerVersion(currentVersion);
			settings[field] = normalized;
			serverVersions[field] = nextVersion;
			accepted[field] = true;
			patch[field] = normalized;
			patch[versionKeys[field]] = nextVersion;
			if (deviceId !== undefined && fieldDeviceIds[field] !== deviceId) {
				fieldDeviceIds[field] = deviceId;
				deviceIdsChanged = true;
			}
		};

		for (const field of fields) {
			apply(field, args[field] as never);
		}
		if (Object.keys(patch).length > 0) {
			patch.updatedAt = Math.max(...Object.values(serverVersions));
			if (deviceIdsChanged) {
				patch.fieldDeviceIds = fieldDeviceIds;
			}
			await ctx.db.patch(existing._id, patch);
		}
		return { accepted, serverVersions, settings };
	},
});
