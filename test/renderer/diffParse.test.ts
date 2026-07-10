import { describe, it, expect } from 'vitest'
import {
  parseDiffFiles,
  fileStatLabel,
  totalDiffStat,
} from '../../src/renderer/lib/diffParse'

// 표준 git diff — 두 파일, 추가/삭제 라인 섞임.
const TWO_FILES = `diff --git a/src/a.ts b/src/a.ts
index 111..222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@
 keep
-old line
+new line one
+new line two
 tail
diff --git a/src/b.ts b/src/b.ts
index 333..444 100644
--- a/src/b.ts
+++ b/src/b.ts
@@ -10,2 +10,1 @@
 ctx
-dropped
`

describe('parseDiffFiles — 파일 분할 + +N/-M 집계', () => {
  it('다중 파일을 헤더로 쪼개고 파일별 추가/삭제를 센다', () => {
    const files = parseDiffFiles(TWO_FILES)
    expect(files.length).toBe(2)
    expect(files[0].path).toBe('src/a.ts')
    expect(files[0].added).toBe(2)
    expect(files[0].removed).toBe(1)
    expect(files[1].path).toBe('src/b.ts')
    expect(files[1].added).toBe(0)
    expect(files[1].removed).toBe(1)
  })

  it('+++/---/@@ 헤더는 집계에서 제외한다', () => {
    const files = parseDiffFiles(TWO_FILES)
    // a.ts: '+new line one','+new line two'만 add(=2), '+++ b/src/a.ts'는 제외
    expect(files[0].added).toBe(2)
    // removed: '-old line'만(=1), '--- a/src/a.ts'는 제외
    expect(files[0].removed).toBe(1)
  })

  it('각 파일 블록의 lines는 자신의 diff --git 헤더부터 시작한다', () => {
    const files = parseDiffFiles(TWO_FILES)
    expect(files[0].lines[0]).toBe('diff --git a/src/a.ts b/src/a.ts')
    expect(files[1].lines[0]).toBe('diff --git a/src/b.ts b/src/b.ts')
    // 두 번째 파일 블록에 첫 파일 라인이 새지 않는다
    expect(files[1].lines.some((l) => l.includes('a.ts'))).toBe(false)
  })
})

describe('parseDiffFiles — 파일명 추출(신규·삭제·rename)', () => {
  it('new file 헤더를 인식한다', () => {
    const files = parseDiffFiles(`diff --git a/x.txt b/x.txt
new file mode 100644
index 000..abc
--- /dev/null
+++ b/x.txt
@@ -0,0 +1,2 @@
+one
+two
`)
    expect(files.length).toBe(1)
    expect(files[0].isNew).toBe(true)
    expect(files[0].path).toBe('x.txt')
    expect(files[0].added).toBe(2)
    expect(files[0].removed).toBe(0)
  })

  it('deleted file은 표시 경로를 a쪽으로 보정한다(b는 /dev/null)', () => {
    const files = parseDiffFiles(`diff --git a/gone.txt b/gone.txt
deleted file mode 100644
index abc..000
--- a/gone.txt
+++ /dev/null
@@ -1,1 +0,0 @@
-bye
`)
    expect(files[0].isDeleted).toBe(true)
    expect(files[0].path).toBe('gone.txt')
    expect(files[0].removed).toBe(1)
  })

  it('rename 헤더(a/x b/y)에서 old→new 경로를 잡는다', () => {
    const files = parseDiffFiles(`diff --git a/old/name.ts b/new/name.ts
similarity index 90%
rename from old/name.ts
rename to new/name.ts
index abc..def 100644
--- a/old/name.ts
+++ b/new/name.ts
@@ -1,1 +1,1 @@
-a
+b
`)
    expect(files[0].isRename).toBe(true)
    expect(files[0].oldPath).toBe('old/name.ts')
    expect(files[0].path).toBe('new/name.ts')
    expect(files[0].added).toBe(1)
    expect(files[0].removed).toBe(1)
  })
})

describe('parseDiffFiles — 바이너리 · 비정상 입력 방어', () => {
  it('바이너리 파일 헤더를 binary로 표시하고 라인 집계는 0', () => {
    const files = parseDiffFiles(`diff --git a/img.png b/img.png
index abc..def 100644
Binary files a/img.png and b/img.png differ
`)
    expect(files[0].binary).toBe(true)
    expect(files[0].added).toBe(0)
    expect(files[0].removed).toBe(0)
    expect(fileStatLabel(files[0])).toBe('bin')
  })

  it('GIT binary patch도 binary로 인식', () => {
    const files = parseDiffFiles(`diff --git a/blob.bin b/blob.bin
new file mode 100644
index 000..abc
GIT binary patch
literal 12
`)
    expect(files[0].binary).toBe(true)
  })

  it('빈 문자열은 빈 배열', () => {
    expect(parseDiffFiles('')).toEqual([])
  })

  it('diff --git 헤더가 없는 비정상 입력은 빈 배열(선행 잡음 무시)', () => {
    expect(parseDiffFiles('그냥 로그\n한 줄 텍스트\n')).toEqual([])
  })

  it('Pm-diff1 — 헝크 본문에서 내용이 -/+로 시작하는 줄(--- x, +++ y)을 파일헤더로 오인하지 않고 집계', () => {
    // 삭제된 줄의 내용이 '-- 주석'이면 unified diff에선 '--- 주석', 추가된 '++ x'는 '+++ x'가 된다.
    // 접두 문자열이 아니라 @@ 이후(inHunk)인지로 판정해야 정확히 removed/added로 잡힌다.
    const files = parseDiffFiles(`diff --git a/q.sql b/q.sql
--- a/q.sql
+++ b/q.sql
@@ -1,2 +1,2 @@
-- old comment
++ old marker
--- deleted dashed
+++ added plussed
 context
`)
    expect(files.length).toBe(1)
    // 본문: '-- old comment'(removed), '--- deleted dashed'(removed) = 2 ; '++ old marker'·'+++ added plussed' = 2
    expect(files[0].removed).toBe(2)
    expect(files[0].added).toBe(2)
  })

  it('diff --git 이전 선행 텍스트는 버리고 헤더부터 파싱', () => {
    const files = parseDiffFiles(`warning: something
diff --git a/f.ts b/f.ts
--- a/f.ts
+++ b/f.ts
@@ -1 +1 @@
-x
+y
`)
    expect(files.length).toBe(1)
    expect(files[0].lines[0]).toBe('diff --git a/f.ts b/f.ts')
    expect(files[0].added).toBe(1)
    expect(files[0].removed).toBe(1)
  })
})

describe('fileStatLabel / totalDiffStat', () => {
  it('+N/-M 라벨 조합', () => {
    const files = parseDiffFiles(TWO_FILES)
    expect(fileStatLabel(files[0])).toBe('+2/-1')
    expect(fileStatLabel(files[1])).toBe('-1')
  })

  it('변화 없는 파일은 ±0', () => {
    const files = parseDiffFiles(`diff --git a/empty.ts b/empty.ts
old mode 100644
new mode 100755
`)
    expect(fileStatLabel(files[0])).toBe('±0')
  })

  it('전체 합계 집계', () => {
    const total = totalDiffStat(parseDiffFiles(TWO_FILES))
    expect(total).toEqual({ files: 2, added: 2, removed: 2 })
  })
})
