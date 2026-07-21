# 릴리스 게이트 — CHANGELOG.md에 현재 버전 섹션이 없으면 배포 거부.
# 용법: npm run dist -- --publish 전에 실행.
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$version = (Get-Content "$repo\package.json" -Raw | ConvertFrom-Json).version
$cl = Get-Content "$repo\CHANGELOG.md" -Raw -Encoding UTF8
if ($cl.IndexOf("## [$version]") -lt 0) {
  Write-Error "CHANGELOG.md에 '## [$version]' 섹션이 없다 - 릴리스 노트부터 작성하라."
  exit 1
}
Write-Output "[release-gate] 통과 - v$version"
