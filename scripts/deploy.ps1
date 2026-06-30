# lain 배포 — 소스를 "설치본"(%LOCALAPPDATA%\Programs\lain)에 반영한다.
# 바탕화면/시작/시작프로그램 바로가기가 가리키는 바로 그 앱을 갱신하는 유일한 경로.
# `npm run build`는 C:\lain\out\ 만 갱신할 뿐 설치본 app.asar 에는 절대 반영되지 않으므로,
# 코드를 바꾼 뒤에는 반드시 이 스크립트(`npm run deploy`)로 설치본까지 밀어 넣어야 한다.
#
# 배포 가드(2026-06-19, 작업 유실 사고 재발 방지):
#  - 커밋되지 않은 변경이 있으면 거부 → in-app 직접 수정·미커밋 작업이 추적불가로 배포되는 것 차단.
#  - 빌드 커밋이 "설치본 커밋"의 자손이 아니면 거부 → 구버전/분기 소스가 더 새 설치본을 덮어써 작업이
#    사라지는 것 차단(핵심). 설치본 BUILD_COMMIT.txt에 빌드 커밋을 각인해 다음 배포가 비교한다.
#  - -Force 로만 우회(긴급용). 텔레그램 /deploy 는 -Force 를 못 주므로 폰 배포는 항상 가드된다.
param([switch]$Force)
$ErrorActionPreference = 'Stop'
# 모든 출력을 로그로 남긴다 — deploy_lain/텔레그램 /deploy는 detached라 출력이 안 보여서, 실패해도
# "원인 불명"이었다(2026-06-20). 이제 레인이 %APPDATA%\lain\deploy.log를 읽어 성공/실패 원인을 본다.
try { Start-Transcript -Path (Join-Path $env:APPDATA 'lain\deploy.log') -Force | Out-Null } catch {}
$root     = Split-Path -Parent $PSScriptRoot
$install  = Join-Path $env:LOCALAPPDATA 'Programs\lain'
$unpacked = Join-Path $root 'dist\win-unpacked'

# 어떤 cwd에서 호출돼도(레인 셸=데이터폴더, Task Scheduler=system32 등) npm/electron-builder가 레포에서
# 돌도록 작업 폴더를 레포 루트로 고정한다. (이게 없어 레인의 자기배포가 'package.json 못 찾음'으로 실패했다)
Set-Location $root

if (-not (Test-Path (Join-Path $install 'lain.exe'))) {
  throw "설치본이 없음: $install — 먼저 한 번 정식 설치 필요 (npm run dist → dist\lain Setup *.exe 실행)"
}

# ── 배포 가드 ──
$head = (& git -C $root rev-parse HEAD 2>$null)
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($head)) {
  throw 'deploy 거부: git 저장소가 아님 (HEAD 확인 실패)'
}
$head = $head.Trim()
$dirty = (& git -C $root status --porcelain)
if ($dirty -and -not $Force) {
  throw "deploy 거부: 커밋되지 않은 변경 존재 — 먼저 커밋/스태시 후 재시도. (긴급 시 -Force)`n$($dirty -join [Environment]::NewLine)"
}
$commitFile = Join-Path $install 'BUILD_COMMIT.txt'
if ((Test-Path $commitFile) -and -not $Force) {
  $installed = (Get-Content $commitFile -Raw).Trim()
  if ($installed) {
    & git -C $root merge-base --is-ancestor $installed $head 2>$null
    if ($LASTEXITCODE -ne 0) {
      $hShort = $head.Substring(0, [Math]::Min(8, $head.Length))
      $iShort = $installed.Substring(0, [Math]::Min(8, $installed.Length))
      throw "deploy 거부: 빌드 커밋($hShort)이 설치본 커밋($iShort)의 자손이 아님 — 더 새 작업을 덮어쓸 위험. 먼저 병합하거나, 의도적이면 -Force."
    }
  }
}

Write-Host '[deploy] 1/4 build (electron-vite)...' -ForegroundColor Cyan
& npm run build
if ($LASTEXITCODE -ne 0) { throw 'build 실패' }

Write-Host '[deploy] 1.5/4 Supertonic 사이드카 의존성 설치(onnxruntime-node)...' -ForegroundColor Cyan
& npm --prefix sidecar/supertonic install --omit=dev
if ($LASTEXITCODE -ne 0) { throw 'sidecar npm install 실패' }

Write-Host '[deploy] 2/4 package (electron-builder --dir, NSIS 생략)...' -ForegroundColor Cyan
& npx electron-builder --win --dir
if ($LASTEXITCODE -ne 0) { throw 'package 실패' }
if (-not (Test-Path $unpacked)) { throw "win-unpacked 산출물 없음: $unpacked" }

Write-Host '[deploy] 3/4 데이터 백업 + 실행 중인 lain 종료...' -ForegroundColor Cyan
# 동기화 전 데이터 백업(보험) — 어떤 경로로든 설정·기록이 유실돼도 직전 상태로 되돌릴 수 있게.
# 데이터는 동기화 대상(%LOCALAPPDATA%) 밖이라 robocopy가 건드리지 않지만, 무조건 한 부 떠 둔다.
$dataDir = Join-Path $env:APPDATA 'lain'
$bk = Join-Path $dataDir 'db-backup-predeploy'
try {
  New-Item -ItemType Directory -Force -Path $bk | Out-Null
  foreach ($f in 'lain.sqlite', 'lain.sqlite-wal', 'lain.sqlite-shm', 'history.ndjson') {
    $src = Join-Path $dataDir $f
    if (Test-Path $src) { Copy-Item $src (Join-Path $bk $f) -Force }
  }
} catch { Write-Host "[deploy] 데이터 백업 경고: $_" -ForegroundColor Yellow }

# graceful 종료 먼저 — `lain.exe --quit`가 second-instance로 app.quit()을 트리거하고, before-quit가
# closeStore()로 WAL을 메인 DB에 합친다(TRUNCATE). 강제종료 시 미체크포인트 WAL이 다음 부팅에 폐기돼
# 설정이 옛값으로 되돌던 상류 트리거를 제거한다. (설치본이 구버전이라 --quit를 모르면 아래 -Force가 폴백)
if (Get-Process lain -ErrorAction SilentlyContinue) {
  try { Start-Process (Join-Path $install 'lain.exe') -ArgumentList '--quit' } catch {}
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Milliseconds 200
    if (-not (Get-Process lain -ErrorAction SilentlyContinue)) { break }
  }
}
# 그래도 살아있으면 강제 종료(폴백) — 설치본 파일 잠금 확실히 해제.
Get-Process lain -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 800  # OS가 exe/asar 핸들을 놓을 때까지 짧게 대기

Write-Host "[deploy] 4/4 설치본 동기화 -> $install" -ForegroundColor Cyan
# /E: 하위 포함 복사·덮어쓰기. 언인스톨러 등 설치본 고유 파일은 보존(미러 아님).
# 변경 없는 파일(전자 바이너리·dll)은 robocopy가 알아서 건너뜀 -> app.asar 위주로 수초 내 완료.
robocopy $unpacked $install /E /NJH /NJS /NP /R:2 /W:1 | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy 실패 (exit $LASTEXITCODE)" }

# 배포된 빌드 커밋을 설치본에 각인 → 다음 배포가 "설치본보다 새 작업만 허용" 가드에 사용.
Set-Content -Path $commitFile -Value $head -Encoding ascii

Write-Host "[deploy] 완료 — 설치본 갱신됨(커밋 $($head.Substring(0,8))). 앱 재시작." -ForegroundColor Green
Start-Process (Join-Path $install 'lain.exe')
