// B17 이미지 입력 — 작업 입력 이미지의 순수 헬퍼(electron/db import 금지, 단위테스트 대상).
import type { FileAttachment } from '../shared/types'

// 용량 가드 — 작업당 이미지 장수·장당 base64 크기 상한. 무한 누적·토큰 폭증·SDK 400 방지.
export const MAX_TASK_IMAGES = 6
export const MAX_IMAGE_B64_CHARS = 5_000_000 // base64 문자수 ≈ 원본 3.7MB

// 첨부 중 '이미지로 안전히 보낼 수 있는 것'만 남긴다 — isImage(=Anthropic 4종 media_type) + 비어있지 않음 + 크기 상한 + 장수 상한.
export function capTaskImages(images: FileAttachment[]): FileAttachment[] {
  return images
    .filter((a) => a.isImage && !!a.data && a.data.length <= MAX_IMAGE_B64_CHARS)
    .slice(0, MAX_TASK_IMAGES)
}

// Anthropic SDK가 받는 이미지 media_type 4종.
export type ImgMedia = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'
export type ImageBlock = { type: 'image'; source: { type: 'base64'; media_type: ImgMedia; data: string } }

// FileAttachment[] → SDKUserMessage 이미지 content block[] (manager.ts와 동형). 이미 cap된 입력을 가정.
export function toImageBlocks(images: FileAttachment[]): ImageBlock[] {
  return images.map((img) => ({
    type: 'image' as const,
    source: { type: 'base64' as const, media_type: img.mimeType as ImgMedia, data: img.data },
  }))
}
