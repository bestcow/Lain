import { describe, it, expect } from 'vitest'
import {
  isSupportedImageMime,
  pickLargestPhoto,
  checkAttachmentSize,
  type TelegramPhotoSize,
} from '../../src/main/telegram-attach'

describe('isSupportedImageMime', () => {
  it('Anthropic 4종 이미지 mime은 지원', () => {
    expect(isSupportedImageMime('image/jpeg')).toBe(true)
    expect(isSupportedImageMime('image/png')).toBe(true)
    expect(isSupportedImageMime('image/gif')).toBe(true)
    expect(isSupportedImageMime('image/webp')).toBe(true)
  })

  it('미지원 mime·빈 값은 false', () => {
    expect(isSupportedImageMime('image/bmp')).toBe(false)
    expect(isSupportedImageMime('image/svg+xml')).toBe(false)
    expect(isSupportedImageMime('application/pdf')).toBe(false)
    expect(isSupportedImageMime(undefined)).toBe(false)
    expect(isSupportedImageMime(null)).toBe(false)
    expect(isSupportedImageMime('')).toBe(false)
  })
})

describe('pickLargestPhoto', () => {
  const mk = (width: number, height: number, file_size?: number): TelegramPhotoSize => ({
    file_id: `${width}x${height}`,
    file_unique_id: `u${width}x${height}`,
    width,
    height,
    file_size,
  })

  it('가장 해상도가 큰 요소를 고른다(텔레그램은 작은 순으로 보냄)', () => {
    const sizes = [mk(90, 90), mk(320, 240), mk(800, 600), mk(1280, 960)]
    expect(pickLargestPhoto(sizes)?.file_id).toBe('1280x960')
  })

  it('순서가 뒤섞여도 최대값을 찾는다', () => {
    const sizes = [mk(800, 600), mk(90, 90), mk(1280, 960), mk(320, 240)]
    expect(pickLargestPhoto(sizes)?.file_id).toBe('1280x960')
  })

  it('빈 배열·미정의는 null', () => {
    expect(pickLargestPhoto([])).toBeNull()
    expect(pickLargestPhoto(undefined as unknown as TelegramPhotoSize[])).toBeNull()
  })

  it('단일 요소는 그대로 반환', () => {
    const sizes = [mk(640, 480)]
    expect(pickLargestPhoto(sizes)?.file_id).toBe('640x480')
  })
})

describe('checkAttachmentSize', () => {
  it('상한 이하면 null(통과)', () => {
    expect(checkAttachmentSize(1_000_000)).toBeNull()
    expect(checkAttachmentSize(20_000_000)).toBeNull() // 경계값(이하) 통과
  })

  it('상한 초과면 안내 문자열', () => {
    expect(checkAttachmentSize(20_000_001)).toMatch(/20MB 초과/)
  })

  it('file_size 미정의면 통과(텔레그램이 크기를 안 줄 수도 있음)', () => {
    expect(checkAttachmentSize(undefined)).toBeNull()
  })

  it('커스텀 상한 지정 가능', () => {
    expect(checkAttachmentSize(6_000_000, 5_000_000)).toMatch(/5MB 초과/)
    expect(checkAttachmentSize(4_000_000, 5_000_000)).toBeNull()
  })
})
