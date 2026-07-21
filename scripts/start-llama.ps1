# 로컬 Qwen 서버 기동 — llama-server(Anthropic /v1/messages 네이티브)로 Qwen3.6-35B-A3B를 서빙.
# 사전 조건: scripts\setup-qwen.ps1 1회 실행. lain의 'local' 티어가 이 서버(기본 :8080)로 라우팅된다.
#
# 플래그 근거(2026-07-02 조사, 로컬 모델 트랙 조사 기록):
#  --jinja       : Anthropic/OpenAI tool calling에 필수(채팅 템플릿 엔진).
#  --ctx-size    : Claude Code 하네스는 컨텍스트가 커서 64K 권장(기본값은 부족).
#  -ngl 99 + --n-cpu-moe : MoE 하이브리드 — 어텐션·공유가중치는 GPU, 라우팅 전문가는 RAM.
#                 RTX 3060급 실측 30~36 tok/s. VRAM이 빠듯하면(GPT-SoVITS 동시 상주) NCpuMoe를 올려라
#                 (값↑ = 전문가를 더 많이 CPU로 = VRAM↓·속도 약간↓). 3060 Ti 8GB + TTS 상주 기준 36~40 권장.
param(
  [int]$Port = 8080,
  [int]$CtxSize = 65536,
  [int]$NCpuMoe = 36,
  # Qwen3.6은 하이브리드 추론이 기본 ON — 판정(judge)류 짧은 호출이 thinking으로 새서 느려지고
  # max_tokens를 다 태운다(실측 38s·본답 미도달, --reasoning-budget 0은 이 템플릿에 안 먹힘 실측).
  # 'off'=추론 끔(판정 용도 기본) / 'on' / 'auto'.
  [string]$Reasoning = 'off',
  [string]$Quant = 'Q4_K_M'
)
$ErrorActionPreference = 'Stop'
$server = Join-Path $env:APPDATA 'lain\llama\llama-server.exe'
$gguf = Join-Path $env:APPDATA "lain\models\Qwen3.6-35B-A3B-UD-$Quant.gguf"
if (-not (Test-Path $server)) { throw "llama-server 없음 — 먼저 scripts\setup-qwen.ps1 실행 ($server)" }
if (-not (Test-Path $gguf)) { throw "GGUF 없음 — 먼저 scripts\setup-qwen.ps1 실행 ($gguf)" }

Write-Host "llama-server 기동 — 포트 $Port, ctx $CtxSize, n-cpu-moe $NCpuMoe, reasoning $Reasoning (RAM 32GB에선 동시 요청 1개 권장)"
& $server -m $gguf --host 127.0.0.1 --port $Port --ctx-size $CtxSize --jinja -ngl 99 --n-cpu-moe $NCpuMoe --parallel 1 --reasoning $Reasoning
