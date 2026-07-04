# Changelog

Lain의 공개 릴리스 변경 기록. 형식은 [Keep a Changelog](https://keepachangelog.com/ko/1.1.0/)를 따르고, 버전은 [SemVer](https://semver.org/lang/ko/)를 쓴다.

## [1.0.0] - 2026-07-04

첫 공식 릴리스.

### 주요 기능

- **관리자 Lain** — 단일 연속 대화(토큰 스트리밍·빠른 대화 레인), 프로젝트 현황 파악, 작업 위임·승인 큐, 시작 시 종료 전 맥락 브리핑
- **작업 실행** — 프로젝트별 git worktree에서 Navi(Claude Code)가 작업 수행, 크래시 복원, 작업 중 인터럽트, Navi 직접 채팅
- **학습 루프** — 대화·작업에서 학습(lesson) 자동 추출·주입, 스킬 자기 생성, 지난 대화 전문 검색(FTS5)
- **유저 감시(오버레이)** — 화면을 관찰하다 도움될 때만 우하단에서 선제 조언(창 단위 고해상 캡처, 앱별 해석, 본인/타인 구별)
- **음성** — TTS 3종(Edge / Supertonic / GPT-SoVITS), 디스코드 음성통화, 음성 톤 설정
- **모바일** — 텔레그램 브리지: 대화·작업 지시·브리핑·`/lessons`·`/search`
- **로컬 모델 티어(실험적)** — llama.cpp(Anthropic 네이티브 API)로 로컬 LLM 라우팅
- **운영** — 자동 업데이트(electron-updater), 트레이 상주, 주기 스캔, CRT 그린 테마 UI
