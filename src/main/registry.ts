// 프로젝트 레지스트리 (PLAN.md §4) — 워크스페이스 루트(C:\workspace) 하위 스캔 + 스택/검증 명령 자동 감지
import fs from 'node:fs'
import path from 'node:path'
import type { Project } from '../shared/types'
import { upsertProject, getProject, getSettings, listProjects } from './store'

const DEFAULT_WORKSPACE_ROOT = 'C:\\workspace'
const DEFAULT_SCAN_DIRS = ['apps', 'games', 'tools']

// E6 — 워크스페이스 루트. 우선순위: 환경변수 LAIN_WORKSPACE > 앱 설정(workspaceRoot) > 기본값.
// 예전엔 env 전용 모듈 상수였다(UI에서 못 바꿈). 이제 설정을 매 스캔 시 읽되 env는 오버라이드로 유지.
export function workspaceRoot(): string {
  return process.env.LAIN_WORKSPACE || getSettings().workspaceRoot.trim() || DEFAULT_WORKSPACE_ROOT
}
// 스캔할 하위 폴더. 우선순위: LAIN_SCAN_DIRS(';' 구분) > 앱 설정(scanDirs) > 기본 apps/games/tools.
function workspaceScanDirs(): string[] {
  const env = process.env.LAIN_SCAN_DIRS?.split(';')
    .map((s) => s.trim())
    .filter(Boolean)
  if (env && env.length) return env
  const set = getSettings().scanDirs.map((s) => s.trim()).filter(Boolean)
  return set.length ? set : [...DEFAULT_SCAN_DIRS]
}
function scanRoots(): string[] {
  const root = workspaceRoot()
  return workspaceScanDirs().map((d) => path.join(root, d))
}
// 렌더러 표시용 — 유효 루트/스캔폴더 + env 오버라이드 여부(설정 표시=실제 일치).
export function workspaceInfo(): {
  root: string
  scanDirs: string[]
  envRootOverride: boolean
  envScanOverride: boolean
} {
  return {
    root: workspaceRoot(),
    scanDirs: workspaceScanDirs(),
    envRootOverride: Boolean(process.env.LAIN_WORKSPACE),
    // 공백뿐인 LAIN_SCAN_DIRS는 workspaceScanDirs()가 무시하므로 오버라이드 아님(설정 표시=실제 일치).
    envScanOverride:
      (process.env.LAIN_SCAN_DIRS?.split(';')
        .map((s) => s.trim())
        .filter(Boolean).length ?? 0) > 0,
  }
}
const EXCLUDE_NAMES = new Set(['node_modules', 'lain', '.git', 'dist', 'out'])
/** 스캔 루트 밖이라 자동 스캔에 안 걸리는 프로젝트 — LAIN_EXTRA_DIRS(';' 구분)로 직접 등록. 기본 없음(UI에서 수동 추가 가능). */
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

// 프로젝트 ID = 유효 루트 기준 상대경로(루트 밖이면 절대경로). 등록(addProject/scanProjects) 시에만
// 호출된다. 루트가 런타임에 바뀌면(E6) 같은 물리 폴더가 다른 id로 산출될 수 있으므로, 재등록은 id가
// 아니라 물리 경로(findByPath)로 먼저 매칭해 기존 행을 재사용한다 → 루트 변경 후에도 재키잉/중복 없음.
function projectId(dir: string): string {
  const rel = path.relative(workspaceRoot(), dir)
  return rel && !rel.startsWith('..') ? rel.replaceAll('\\', '/') : dir.replaceAll('\\', '/')
}

// 물리 경로 정규화 — win32는 대소문자 무시, 구분자·후행 슬래시 통일. path 기반 dedup의 단일 기준.
function normPath(p: string): string {
  const r = path.resolve(p).replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? r.toLowerCase() : r
}
// 같은 물리 폴더로 등록된 기존 프로젝트를 찾는다. 루트 변경으로 projectId(상대경로)가 달라져도
// id만으로는 못 찾는 기존 행을 path로 매칭해 중복 INSERT·이력(대화·학습·작업) 유실을 막는다.
function findByPath(dir: string): Project | undefined {
  const target = normPath(dir)
  return listProjects().find((p) => normPath(p.path) === target)
}

export function addProject(dir: string): Project {
  const existing = findByPath(dir) ?? getProject(projectId(dir))
  const detected = detectProject(dir)
  const project: Project = {
    id: existing?.id ?? projectId(dir), // 기존 폴더면 그 id 재사용(재키잉 방지)
    path: dir,
    name: path.basename(dir),
    ...detected,
  }
  upsertProject(project)
  return project
}

/** 스캔 루트 바로 아래 폴더들을 프로젝트로 등록. 신규 등록 수를 반환(경로 기준 dedup). */
export function scanProjects(): number {
  let added = 0
  for (const root of scanRoots()) {
    if (!fs.existsSync(root)) continue
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || EXCLUDE_NAMES.has(entry.name)) continue
      const dir = path.join(root, entry.name)
      if (!findByPath(dir)) added++ // 물리 경로 기준 — 루트 변경 후에도 신규 판정 정확
      addProject(dir)
    }
  }
  for (const dir of EXTRA_DIRS) {
    if (!fs.existsSync(dir)) continue
    if (!findByPath(dir)) added++
    addProject(dir)
  }
  return added
}
