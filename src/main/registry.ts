// 프로젝트 레지스트리 (PLAN.md §4) — 워크스페이스 루트(C:\workspace) 하위 스캔 + 스택/검증 명령 자동 감지
import fs from 'node:fs'
import path from 'node:path'
import type { Project } from '../shared/types'
import { upsertProject, getProject } from './store'

// 워크스페이스 루트 — 기본값 C:\workspace, 환경변수 LAIN_WORKSPACE로 변경 가능(다른 머신/경로 지원).
const DEV_ROOT = process.env.LAIN_WORKSPACE || 'C:\\workspace'
// 스캔할 하위 폴더 — 기본 apps/games/tools, LAIN_SCAN_DIRS(';' 구분)로 변경 가능.
const SCAN_ROOTS = (process.env.LAIN_SCAN_DIRS?.split(';').filter(Boolean) ?? ['apps', 'games', 'tools']).map(
  (d) => path.join(DEV_ROOT, d),
)
const EXCLUDE_NAMES = new Set(['node_modules', 'lain', '.git', 'dist', 'out'])
/** SCAN_ROOTS 밖이라 자동 스캔에 안 걸리는 프로젝트 — LAIN_EXTRA_DIRS(';' 구분)로 직접 등록. 기본 없음(UI에서 수동 추가 가능). */
const EXTRA_DIRS = process.env.LAIN_EXTRA_DIRS?.split(';').filter(Boolean) ?? []

function readJsonSafe(p: string): any | null {
  try {
    // BOM 제거 (Windows 도구들이 UTF-8 BOM을 붙이는 경우가 흔함)
    return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, ''))
  } catch {
    return null
  }
}

export function detectProject(dir: string): Pick<Project, 'stack' | 'verifyCmd' | 'isGit'> {
  const isGit = fs.existsSync(path.join(dir, '.git'))
  const pkg = readJsonSafe(path.join(dir, 'package.json'))
  if (pkg) {
    const scripts = pkg.scripts ?? {}
    const verifyCmd = scripts.test
      ? 'npm test'
      : scripts.typecheck
        ? 'npm run typecheck'
        : scripts.build
          ? 'npm run build'
          : null
    return { stack: 'node', verifyCmd, isGit }
  }
  if (fs.existsSync(path.join(dir, 'project.godot'))) {
    return { stack: 'godot', verifyCmd: null, isGit }
  }
  if (
    fs.existsSync(path.join(dir, 'pyproject.toml')) ||
    fs.existsSync(path.join(dir, 'requirements.txt'))
  ) {
    const hasTests = fs.existsSync(path.join(dir, 'tests'))
    return { stack: 'python', verifyCmd: hasTests ? 'pytest' : null, isGit }
  }
  if (fs.existsSync(path.join(dir, 'index.html'))) {
    return { stack: 'static', verifyCmd: null, isGit }
  }
  return { stack: null, verifyCmd: null, isGit }
}

function projectId(dir: string): string {
  const rel = path.relative(DEV_ROOT, dir)
  return rel && !rel.startsWith('..') ? rel.replaceAll('\\', '/') : dir.replaceAll('\\', '/')
}

export function addProject(dir: string): Project {
  const id = projectId(dir)
  const existing = getProject(id)
  const detected = detectProject(dir)
  const project: Project = {
    id,
    path: dir,
    name: path.basename(dir),
    enabled: existing?.enabled ?? true,
    ...detected,
  }
  upsertProject(project)
  return project
}

/** SCAN_ROOTS 바로 아래 폴더들을 프로젝트로 등록. 신규 등록 수를 반환. */
export function scanProjects(): number {
  let added = 0
  for (const root of SCAN_ROOTS) {
    if (!fs.existsSync(root)) continue
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || EXCLUDE_NAMES.has(entry.name)) continue
      const dir = path.join(root, entry.name)
      if (!getProject(projectId(dir))) added++
      addProject(dir)
    }
  }
  for (const dir of EXTRA_DIRS) {
    if (!fs.existsSync(dir)) continue
    if (!getProject(projectId(dir))) added++
    addProject(dir)
  }
  return added
}
