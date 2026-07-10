// 텔레그램 인바운드 사진·문서 첨부(B14) — 순수 판정 로직만 분리(테스트 용이). 다운로드·라우팅은 telegram.ts.
// Anthropic 이미지 4종만 지원(렌더러 isImageMime과 동일 기준 — 계층 분리로 여기서 독립 정의).

/** Telegram PhotoSize — getUpdates의 message.photo 배열 원소. */
export interface TelegramPhotoSize {
  file_id: string
  file_unique_id: string
  width: number
  height: number
  file_size?: number
}

const SUPPORTED_IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp']

/** Anthropic이 받는 이미지 4종만 이미지로 취급 — 그 외 mime은 문서로도 첨부 거부(§B14). */
export function isSupportedImageMime(mimeType: string | undefined | null): boolean {
  return !!mimeType && SUPPORTED_IMAGE_MIMES.includes(mimeType)
}

/** photo 배열에서 최대 해상도(width*height) 요소를 고른다 — 텔레그램은 작은 것부터 순서대로 보낸다. */
export function pickLargestPhoto(sizes: TelegramPhotoSize[]): TelegramPhotoSize | null {
  if (!sizes || sizes.length === 0) return null
  return sizes.reduce((best, cur) => (cur.width * cur.height > best.width * best.height ? cur : best))
}

/** 다운로드 전 크기 제한 체크 — 초과 시 이유 문자열, 통과 시 null. voice와 동일 상한(Bot API getFile 제약). */
export function checkAttachmentSize(fileSize: number | undefined, maxBytes = 20_000_000): string | null {
  if (fileSize != null && fileSize > maxBytes) {
    return `파일이 너무 크다 (${Math.round(maxBytes / 1_000_000)}MB 초과)`
  }
  return null
}
