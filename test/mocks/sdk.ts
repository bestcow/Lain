// vitest용 @anthropic-ai/claude-agent-sdk 스텁 — worker/orchestrator 등이 top-level import만 한다.
// 테스트 대상은 순수함수라 query/tool/createSdkMcpServer를 실제로 호출하지 않는다 → 빈 깡통이면 충분.
import { vi } from 'vitest'

export const query = vi.fn()
export const tool = vi.fn((..._args: unknown[]) => ({}))
export const createSdkMcpServer = vi.fn(() => ({}))

export default { query, tool, createSdkMcpServer }
