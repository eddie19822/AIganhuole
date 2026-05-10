import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    root: __dirname,
    include: ['test/**/*.{test,spec}.?(c|m)[jt]s?(x)'],
    /** Playwright 驱动 Electron，需在桌面环境手动跑 `npx playwright test` */
    exclude: ['test/e2e.spec.ts'],
    passWithNoTests: true,
    testTimeout: 1000 * 29,
  },
})
