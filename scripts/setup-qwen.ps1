# 로컬 Qwen 셋업 — llama.cpp(llama-server) + Qwen3.6-35B-A3B GGUF 다운로드 (1회 실행, 설치 총 ~22.5GB)
# 대상: %APPDATA%\lain\llama\ (실행파일) + %APPDATA%\lain\models\ (GGUF) — lain 재설치에도 보존되는 데이터 폴더.
# 추가 의존성 없음: Python·Ollama·프록시 불필요. llama-server가 Anthropic /v1/messages를 네이티브로 말한다.
# 다운로드는 curl.exe(Windows 10+ 내장) — 스트리밍 + 중단 이어받기(-C -). 중단돼도 재실행하면 이어받는다.
# 이후 기동은 scripts\start-llama.ps1, lain 쪽은 환경설정 모델 티어에서 'local' 선택.
param(
  # 양자화 선택 — 기본 Q4_K_M(22.1GB, RTX 3060급+RAM 32GB 실측 구성). RAM이 빠듯하면 Q4_K_S(20.9GB).
  [string]$Quant = 'Q4_K_M',
  [string]$ModelRepo = 'unsloth/Qwen3.6-35B-A3B-GGUF' # 실측 확인 2026-07-02 (Qwen 공식 GGUF 레포는 비공개)
)
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$curl = "$env:SystemRoot\System32\curl.exe"
if (-not (Test-Path $curl)) { throw 'curl.exe 없음 — Windows 10 1803+ 필요' }

$llamaDir = Join-Path $env:APPDATA 'lain\llama'
$modelDir = Join-Path $env:APPDATA 'lain\models'
New-Item -ItemType Directory -Force $llamaDir | Out-Null
New-Item -ItemType Directory -Force $modelDir | Out-Null

# ── 1/2 llama.cpp 최신 릴리스(win-cuda x64) ─────────────────────────────────────
Write-Host '[1/2] llama.cpp 릴리스 조회...'
$rel = Invoke-RestMethod 'https://api.github.com/repos/ggml-org/llama.cpp/releases/latest'
# 본체(bin-win-cuda x64) + CUDA 런타임(cudart) 두 zip — 자산 이름 규칙이 종종 바뀌어 패턴으로 고른다.
# ⚠ cudart-llama-'bin-win-cuda'-x64.zip이 본체 패턴에도 매치되므로 본체에서 cudart를 명시 제외.
$binAsset = $rel.assets | Where-Object { $_.name -match 'bin-win.*cuda.*x64.*\.zip$' -and $_.name -notmatch 'cudart' } | Select-Object -First 1
$cudartAsset = $rel.assets | Where-Object { $_.name -match 'cudart.*win.*x64.*\.zip$' } | Select-Object -First 1
if (-not $binAsset) { throw "llama.cpp win-cuda 자산을 못 찾음 — 릴리스($($rel.tag_name)) 자산 이름 규칙 변경. 수동 확인: https://github.com/ggml-org/llama.cpp/releases" }
foreach ($a in @($binAsset, $cudartAsset)) {
  if (-not $a) { continue }
  Write-Host "  다운로드: $($a.name) ($($rel.tag_name))"
  $zip = Join-Path $env:TEMP $a.name
  # -sS: 진행 표시(stderr) 억제 — PS 5.1이 네이티브 stderr를 ErrorRecord로 감싸 오탐 종료하는 것 방지.
  & $curl -L --fail -sS -o $zip $a.browser_download_url
  if ($LASTEXITCODE -ne 0) { throw "다운로드 실패(curl exit $LASTEXITCODE): $($a.name)" }
  Expand-Archive $zip -DestinationPath $llamaDir -Force
}
if (-not (Test-Path (Join-Path $llamaDir 'llama-server.exe'))) {
  # zip 안에 하위 폴더가 있는 배포 형태 대비 — 찾아서 루트로 승격
  $found = Get-ChildItem $llamaDir -Recurse -Filter 'llama-server.exe' | Select-Object -First 1
  if ($found) { Get-ChildItem $found.Directory | Move-Item -Destination $llamaDir -Force }
  else { throw 'llama-server.exe가 zip에 없음 — 자산 구성 변경, 수동 확인 필요' }
}
Write-Host "  llama-server: $(Join-Path $llamaDir 'llama-server.exe')"

# ── 2/2 Qwen3.6-35B-A3B GGUF (~22GB — 오래 걸림, 중단 시 재실행하면 이어받음) ──
$ggufName = "Qwen3.6-35B-A3B-UD-$Quant.gguf"
$ggufPath = Join-Path $modelDir $ggufName
$part = "$ggufPath.part"
$url = "https://huggingface.co/$ModelRepo/resolve/main/$ggufName"
# 기대 크기 — HF API에서 조회(완료 판정·손상 감지 공용). 조회 실패 시 0(크기 검증 생략).
$expected = 0
try {
  $tree = Invoke-RestMethod "https://huggingface.co/api/models/$ModelRepo/tree/main"
  $entry = $tree | Where-Object { $_.path -eq $ggufName } | Select-Object -First 1
  if ($entry -and $entry.size) { $expected = [long]$entry.size }
} catch { Write-Host '  (HF 크기 조회 실패 — 크기 검증 생략)' }
$have = 0
if (Test-Path $ggufPath) { $have = (Get-Item $ggufPath).Length }
if ($have -gt 0 -and ($expected -eq 0 -or $have -eq $expected)) {
  Write-Host "[2/2] 모델 이미 있음(크기 확인됨): $ggufPath — 스킵"
} else {
  if ($have -gt 0) {
    # 과거 중단으로 최종 경로에 잘린 파일이 남은 경우 — 폐기하고 .part 이어받기 경로로.
    Write-Host "  기존 파일 크기 불일치($have / $expected) — 손상 판정, 재다운로드"
    Remove-Item $ggufPath -Force
  }
  Write-Host "[2/2] GGUF 다운로드(~22GB): $ModelRepo/$ggufName"
  # .part로 받고 완료·크기검증 후에만 최종 이름으로 커밋(원자적) — 잘린 파일이 '설치됨'으로 오판되는 것 차단.
  # -sS: 진행 표시 억제(위와 동일 사유). 진행 확인은 .part 파일 크기로.
  & $curl -L --fail -sS -C - -o $part $url
  if ($LASTEXITCODE -ne 0) { throw "다운로드 실패(curl exit $LASTEXITCODE) — 재실행하면 $part 에서 이어받는다" }
  if ($expected -gt 0 -and (Get-Item $part).Length -ne $expected) {
    throw "크기 불일치($((Get-Item $part).Length) / $expected) — 재실행하면 이어받는다"
  }
  Move-Item $part $ggufPath -Force
}
Write-Host ''
Write-Host '완료. 서버 기동: powershell -File scripts\start-llama.ps1'
Write-Host "lain 설정: 환경설정 - 모델 - 원하는 티어(판정 권장)를 'local'로, 서버 주소 기본값 http://127.0.0.1:8080"
