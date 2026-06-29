// vitest 전용 설정 — electron-vite는 이 파일을 읽지 않으므로 dev/build/dist/deploy에 무영향.
// 핵심: 'electron'과 SDK를 가벼운 스텁으로 alias한다. paths.ts가 모듈 평가 시점에 app.isPackaged를
// 호출해 Electron 런타임 밖(vitest)에서 throw하기 때문. SDK는 import만 되면 되므로 빈 깡통.
import { defineConfig } from 'vitest/config'
import path from 'node:path'

export default defineConfig({
  test: {
    // 메인은 node, 렌더러(src/renderer/**)만 jsdom — highlight 등 JSX 반환 헬퍼용.
    environment: 'node',
    environmentMatchGlobs: [['src/renderer/**', 'jsdom']],
    include: ['test/**/*.{test,spec}.{ts,tsx}'],
    globals: false,
  },
  resolve: {
    alias: {
      electron: path.resolve(__dirname, 'test/mocks/electron.ts'),
      '@anthropic-ai/claude-agent-sdk': path.resolve(__dirname, 'test/mocks/sdk.ts'),
    },
  },
})
