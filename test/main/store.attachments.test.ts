import { describe, it, expect, vi } from 'vitest'
import path from 'node:path'
import type { FileAttachment } from '../../src/shared/types'

// serialize/parse는 DB를 안 쓰지만 store import가 paths를 끌어오므로 가볍게 mock.
vi.mock('../../src/main/paths', () => ({
  DATA_DIR: path.join(process.cwd(), 'data'),
  PROJECT_ROOT: process.cwd(),
  AGENT_CWD: process.cwd(),
  BENCH_DIR: path.join(process.cwd(), 'bench'),
  CLAUDE_BIN: 'claude',
}))

import { serializeAttachments, parseAttachments } from '../../src/main/store'

const CAP = 256 * 1024
const img = (data: string): FileAttachment => ({ name: 'a.png', mimeType: 'image/png', data, isImage: true })
const txt = (data: string): FileAttachment => ({ name: 'a.txt', mimeType: 'text/plain', data, isImage: false })

describe('serializeAttachments — 첨부 직렬화 cap(256KB)', () => {
  it('빈/undefined → null', () => {
    expect(serializeAttachments(undefined)).toBeNull()
    expect(serializeAttachments([])).toBeNull()
  })

  it('텍스트 첨부는 크기 무관 data 비움(메타만 보존)', () => {
    const out = JSON.parse(serializeAttachments([txt('hi')])!)
    expect(out[0]).toMatchObject({ name: 'a.txt', mimeType: 'text/plain', isImage: false, data: '' })
  })

  it('상한 이하 이미지는 data 보존', () => {
    const data = 'a'.repeat(100)
    const out = JSON.parse(serializeAttachments([img(data)])!)
    expect(out[0].data).toBe(data)
  })

  it('경계: 정확히 256KB는 보존(> 비교)', () => {
    const data = 'a'.repeat(CAP)
    const out = JSON.parse(serializeAttachments([img(data)])!)
    expect(out[0].data).toBe(data)
  })

  it('상한 초과 이미지는 data 비움(칩 폴백)', () => {
    const data = 'a'.repeat(CAP + 1)
    const out = JSON.parse(serializeAttachments([img(data)])!)
    expect(out[0].data).toBe('')
    expect(out[0].isImage).toBe(true)
    expect(out[0].name).toBe('a.png')
  })

  it('cap은 base64 문자열 length 기준(디코드 바이트 아님)', () => {
    // length는 UTF-16 code unit. CAP 경계는 .length로 잰다.
    expect(JSON.parse(serializeAttachments([img('x'.repeat(CAP))])!)[0].data.length).toBe(CAP)
    expect(JSON.parse(serializeAttachments([img('x'.repeat(CAP + 1))])!)[0].data).toBe('')
  })
})

describe('parseAttachments — 역직렬화', () => {
  it('falsy/빈문자 → undefined', () => {
    expect(parseAttachments(null)).toBeUndefined()
    expect(parseAttachments(undefined)).toBeUndefined()
    expect(parseAttachments('')).toBeUndefined()
  })
  it('잘못된 JSON → undefined', () => {
    expect(parseAttachments('{not json')).toBeUndefined()
  })
  it('빈 배열 JSON → undefined', () => {
    expect(parseAttachments('[]')).toBeUndefined()
  })
  it('비배열 JSON → undefined', () => {
    expect(parseAttachments('{"a":1}')).toBeUndefined()
  })
  it('round-trip: serialize → parse', () => {
    const raw = serializeAttachments([img('abc'), txt('hello')])
    const back = parseAttachments(raw)
    expect(back).toHaveLength(2)
    expect(back![0]).toMatchObject({ isImage: true, data: 'abc' })
    expect(back![1]).toMatchObject({ isImage: false, data: '' })
  })
})
