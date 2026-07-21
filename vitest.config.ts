// vitest 전용 설정 — electron-vite는 이 파일을 읽지 않으므로 dev/build/dist/deploy에 무영향.
// 핵심: 'electron'과 SDK를 가벼운 스텁으로 alias한다. paths.ts가 모듈 평가 시점에 app.isPackaged를
// 호출해 Electron 런타임 밖(vitest)에서 throw하기 때문. SDK는 import만 되면 되므로 빈 깡통.
import { defineConfig } from 'vitest/config'
import path from 'node:path'

export default defineConfig({
  test: {
    // 전 테스트 node 환경 — 렌더러 테스트도 DOM 미사용(ReactNode 구조 검사).
    environment: 'node',
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
