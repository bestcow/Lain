import type { LainApi } from '../shared/types'

declare global {
  interface Window {
    lain: LainApi
  }
}

export {}
