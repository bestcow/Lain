import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

export default defineConfig({
  main: { plugins: [externalizeDepsPlugin()] },
  preload: { plugins: [externalizeDepsPlugin()] },
  renderer: {
    plugins: [react()],
    // 미니파이 시 함수·클래스 이름 보존 — 스택트레이스와 React DevTools 컴포넌트 이름이 살아 있어야 한다
    esbuild: { keepNames: true },
    build: {
      // electron-vite 렌더러 프리셋 기본값이 minify:false라 번들이 원본 그대로 나간다 — 렌더러만 미니파이 복구
      minify: 'esbuild',
      // 멀티 렌더러 엔트리 — 메인 UI(index) + 어깨너머 오버레이(overlay) 경량 창
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          overlay: resolve(__dirname, 'src/renderer/overlay/index.html'),
        },
      },
    },
  },
})
