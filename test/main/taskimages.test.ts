import { describe, it, expect } from 'vitest'
import {
  capTaskImages,
  toImageBlocks,
  MAX_TASK_IMAGES,
  MAX_IMAGE_B64_CHARS,
} from '../../src/main/taskimages'
import type { FileAttachment } from '../../src/shared/types'

const img = (over: Partial<FileAttachment> = {}): FileAttachment => ({
  name: 'a.png',
  mimeType: 'image/png',
  data: 'AAAA',
  isImage: true,
  ...over,
})

describe('capTaskImages', () => {
  it('이미지 아닌 첨부(isImage=false) 제거', () => {
    const out = capTaskImages([img(), img({ isImage: false, mimeType: 'text/plain' })])
    expect(out).toHaveLength(1)
    expect(out[0].isImage).toBe(true)
  })
  it('빈 data 제거', () => {
    expect(capTaskImages([img({ data: '' })])).toHaveLength(0)
  })
  it('크기 상한 초과 제거', () => {
    const big = img({ data: 'x'.repeat(MAX_IMAGE_B64_CHARS + 1) })
    expect(capTaskImages([big])).toHaveLength(0)
    const okSize = img({ data: 'x'.repeat(MAX_IMAGE_B64_CHARS) })
    expect(capTaskImages([okSize])).toHaveLength(1)
  })
  it('장수 상한으로 자름', () => {
    const many = Array.from({ length: MAX_TASK_IMAGES + 3 }, () => img())
    expect(capTaskImages(many)).toHaveLength(MAX_TASK_IMAGES)
  })
  it('빈 입력은 빈 배열', () => {
    expect(capTaskImages([])).toEqual([])
  })
})

describe('toImageBlocks', () => {
  it('FileAttachment → base64 이미지 블록', () => {
    const blocks = toImageBlocks([img({ mimeType: 'image/webp', data: 'ZZZZ' })])
    expect(blocks).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/webp', data: 'ZZZZ' } },
    ])
  })
})
