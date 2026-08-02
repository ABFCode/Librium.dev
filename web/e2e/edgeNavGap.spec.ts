import { expect, type Page, test } from "@playwright/test";
import { buildFixtureEpub } from "./fixtureEpub";

// The Kindle-style margin click-zones must keep a dead gutter between the
// text column and where the clickable area starts: clicks landing near the
// text (ending a selection, refocusing) must not flip chapters.

const email = `e2e-edge-gap-${Date.now()}@test.local`;
const password = "e2e-password-123";
const title = "Edge Gap Fixture";

const shot = async (page: Page, name: string) => {
	const dir = process.env.LIVE_SHOT_DIR;
	if (dir) {
		await page.screenshot({ path: `${dir}/${name}.png` });
	}
};

test("edge chapter-nav zones keep a dead gutter beside the text column", async ({
	page,
}) => {
	test.setTimeout(120_000);
	await page.setViewportSize({ width: 1440, height: 900 });

	await page.goto("/sign-up");
	await page.getByPlaceholder("Name").fill("Gap Reader");
	await page.getByPlaceholder("Email").fill(email);
	await page.getByPlaceholder("Password").fill(password);
	await page.getByRole("button", { name: "Create account" }).click();
	await page.waitForURL("**/library", { timeout: 20_000 });

	await page.goto("/import");
	await page.locator('input[type="file"][accept*="epub"]').setInputFiles({
		name: "edge-gap.epub",
		mimeType: "application/epub+zip",
		buffer: Buffer.from(buildFixtureEpub(title)),
	});
	await page.getByRole("button", { name: /Import 1 book/ }).click();
	await expect(page.locator(".queue-status")).toHaveText("Ready", {
		timeout: 30_000,
	});
	await page.goto("/library");
	await page
		.locator(".book-card", { hasText: title })
		.getByRole("link")
		.first()
		.click();
	await expect(page.locator(".reader-topbar-title")).toHaveText(/Chapter/, {
		timeout: 20_000,
	});

	const geometry = await page.evaluate(() => {
		const content = document.querySelector(".reader-content");
		const left = document.querySelector(".reader-edge-nav.is-left");
		const right = document.querySelector(".reader-edge-nav.is-right");
		if (!content || !left || !right) {
			return null;
		}
		const contentRect = content.getBoundingClientRect();
		const columnWidth = Number.parseFloat(
			getComputedStyle(content).getPropertyValue("--reader-content-w"),
		);
		const columnLeft = contentRect.left + (contentRect.width - columnWidth) / 2;
		const columnRight = columnLeft + columnWidth;
		const leftRect = left.getBoundingClientRect();
		const rightRect = right.getBoundingClientRect();
		return {
			leftZoneWidth: leftRect.width,
			rightZoneWidth: rightRect.width,
			leftGap: columnLeft - leftRect.right,
			rightGap: rightRect.left - columnRight,
		};
	});
	expect(geometry).not.toBeNull();
	if (!geometry) {
		return;
	}
	// Both zones exist with a usable target...
	expect(geometry.leftZoneWidth).toBeGreaterThanOrEqual(44);
	expect(geometry.rightZoneWidth).toBeGreaterThanOrEqual(44);
	// ...and neither starts closer than the dead gutter to the text column.
	// (56 = the 64px --reader-edge-gap with tolerance for subpixel layout;
	// the right zone is additionally inset 14px for the scrollbar.)
	expect(geometry.leftGap).toBeGreaterThanOrEqual(56);
	expect(geometry.rightGap).toBeGreaterThanOrEqual(56);

	// Walkthrough screenshot: outline the zones so the gutter is visible.
	await page.addStyleTag({
		content: `.reader-edge-nav { outline: 2px dashed #eab308; outline-offset: -2px; opacity: 1 !important; }`,
	});
	await shot(page, "edge-nav-zones");
});
