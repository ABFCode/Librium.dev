import { fileURLToPath, URL } from "node:url";
import viteReact from "@vitejs/plugin-react";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: {
		tsconfigPaths: true,
		alias: [
			{
				find: "virtual:pwa-register",
				replacement: fileURLToPath(
					new URL("./src/test/pwaRegisterMock.ts", import.meta.url),
				),
			},
			{
				find: /^@\//,
				replacement: `${fileURLToPath(new URL("./src", import.meta.url))}/`,
			},
		],
		dedupe: ["react", "react-dom"],
	},
	optimizeDeps: {
		include: [
			"@convex-dev/better-auth/react",
			"@tanstack/react-devtools",
			"@tanstack/react-router",
			"@tanstack/react-router-devtools",
			"@tanstack/react-virtual",
			"react",
			"react-dom",
			"react-dom/client",
			"react/jsx-runtime",
			"react/jsx-dev-runtime",
			"vitest-browser-react",
			"convex/react",
			"convex/server",
		],
	},
	plugins: [viteReact()],
	test: {
		testTimeout: 10_000,
		projects: [
			{
				test: {
					name: "node",
					// Root-level testTimeout does not reach project configs (observed
					// on vitest 4.1.10: the real-EPUB corpus parse hit the 5s default
					// under full-suite CPU contention). Set explicitly per project;
					// the corpus book gets extra headroom.
					testTimeout: 20_000,
					include: ["src/test/**/*.test.{ts,tsx}"],
					exclude: [
						"src/test/**/*.browser.test.{ts,tsx}",
						"src/test/**/*.convex.test.{ts,tsx}",
					],
					environment: "node",
				},
			},
			{
				// convex-test runs the real backend functions in an in-memory
				// Convex on the edge runtime.
				test: {
					name: "convex",
					testTimeout: 10_000,
					include: ["src/test/**/*.convex.test.{ts,tsx}"],
					environment: "edge-runtime",
					server: { deps: { inline: ["convex-test"] } },
				},
			},
			{
				test: {
					name: "browser",
					testTimeout: 10_000,
					// Browser-only setup (vitest-browser-react) must not load in the
					// node project.
					setupFiles: ["./src/test/setup.ts"],
					include: ["src/test/**/*.browser.test.{ts,tsx}"],
					browser: {
						enabled: true,
						// These component suites mock shared modules such as convex/react.
						// Run files serially so a slower CI browser cannot observe another
						// file's mock graph while Vite is still loading it.
						fileParallelism: false,
						provider: playwright(),
						instances: [{ browser: "chromium" }],
						headless:
							process.env.VITEST_BROWSER_HEADLESS === "true" ||
							Boolean(process.env.CI),
					},
				},
			},
		],
	},
});
