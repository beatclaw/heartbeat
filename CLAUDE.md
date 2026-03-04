# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 프로젝트 개요

Heartbeat (`@beatclaw/heartbeat`) — agentic 코딩 CLI(Claude Code, Codex CLI)에 Telegram 인터페이스와 자율 heartbeat 실행을 부여하는 daemon. Telegram 메시지를 수신하면 CLI를 spawn하고, stdout을 실시간 스트리밍(Bot API 9.5 `sendMessageDraft`)으로 돌려보낸다. 주기적 heartbeat으로 변경사항을 감지해 자동 트리거도 가능.

## 빌드 / 실행

```bash
npm install          # 의존성 설치
npm run build        # TypeScript → dist/ 컴파일
npm run dev          # watch 모드 컴파일
npm start            # daemon 실행 (config.yaml 필요)
npm run setup        # 대화형 설정 마법사
```

빌드 검증: `npm run build`가 에러 없이 완료되면 통과. 별도 lint/test 스크립트 없음.

## 아키텍처

```
Telegram ← grammY long-polling → Daemon (index.ts) ← MCP SSE (localhost:39100) → CLI
                                      ↓
                                Heartbeat timer → shell checks → CLI spawn (변경 감지 시)
```

daemon은 세 개의 동시 서브시스템을 실행:
1. **Telegram Bot** (grammY) — 메시지 수신/버퍼링, 결과 스트리밍
2. **MCP SSE Server** (`@modelcontextprotocol/sdk`) — CLI에 `telegram_read`, `telegram_send`, `heartbeat_check` 도구 제공. Bearer 토큰 인증, `127.0.0.1` 바인딩
3. **Heartbeat Timer** — 설정된 주기로 cheap shell check 실행, 출력이 있을 때만 CLI spawn

## 핵심 데이터 흐름

### 메시지 → CLI → 스트리밍

1. Telegram 메시지 수신 → `messageBuffer`에 immutable append
2. `spawnCli('user')` — CLI 프로세스 spawn (`--dangerously-skip-permissions --output-format stream-json`)
3. stdout 파싱: `CliBuilder.extractText()`로 JSON 스트림에서 텍스트 추출
4. 추출된 텍스트 → `sendMessageDraft()`로 실시간 스트리밍 (throttle 200ms)
5. CLI 종료 → `sendMessage()`로 최종 메시지 발송 (비밀 자동 레닥션)

### 세션 관리

- **user/heartbeat 분리 세션** — 각각 독립된 `session_id`와 턴 카운트 유지
- **세션 연속성** — 첫 실행 이후 `--continue`로 기존 세션 이어감. 실패 시 fresh 세션으로 자동 재시도
- **크로스 컨텍스트** — user 세션 결과가 heartbeat 프롬프트에, heartbeat 결과가 user 프롬프트에 read-only로 주입 (500자 제한)
- **HEARTBEAT_OK** — heartbeat CLI가 이 문자열만 출력하면 Telegram 메시지 전송 억제

## 소스 파일 역할

| 파일 | 역할 |
|------|------|
| `src/index.ts` | 메인 daemon — 세 서브시스템 통합, CLI spawner, 스트리밍, 세션/컨텍스트/메시지 버퍼 관리 |
| `src/cli.ts` | `CliBuilder` 인터페이스 + 구현체. Claude Code는 `stream-json` 형식 파싱, Codex는 JSON/plaintext 혼합 파싱 |
| `src/sandbox.ts` | OS 샌드박스 래퍼 — macOS: `sandbox-exec` (파일 쓰기만 제한), Linux: `bubblewrap` (ro-bind + 허용 경로만 bind) |
| `src/setup.ts` | 대화형 설정 — config.yaml 생성, chat ID 자동 감지, MCP 등록, 시스템 서비스(launchd/systemd) 설치 |
| `templates/CLAUDE.md` | Claude Code용 에이전트 시스템 프롬프트 (현재 두 파일 내용 동일) |
| `templates/AGENTS.md` | Codex CLI용 에이전트 시스템 프롬프트 |

## 설정 파일

`config.yaml` (gitignored, `config.yaml.example` 참조):
- `agent`: CLI 종류 (`claude`|`codex`), cwd, timeout, 세션 최대 턴
- `telegram`: 봇 토큰(`env:` 프리픽스로 환경변수 참조 가능), default_chat_id, allowed_users 화이트리스트
- `heartbeat`: 간격(`30m`, `1h` 등), active_hours, 체크 명령 배열, 프롬프트
- `mcp`: 포트, bearer 토큰
- `sandbox`: 활성화 여부, allowed_paths (`${agent.cwd}` 치환 지원), extra_paths
- `streaming`: throttle(ms), fallback

## 새 CLI 추가 방법

1. `src/cli.ts`에 `CliBuilder` 구현 클래스 추가 — `buildArgs`, `parseSessionId`, `extractText` 구현
2. `getCliBuilder()` factory switch에 등록
3. `templates/`에 시스템 프롬프트 추가
4. `src/setup.ts`의 CLI 선택 목록과 `registerMcp()`에 등록 명령 추가

## Telegram 명령어 관리

`src/index.ts`에 `bot.command()`로 등록된 Telegram 명령어를 추가/수정/삭제할 때, **반드시 `/help` 명령어의 응답 텍스트도 함께 업데이트**해야 한다. `/help` 핸들러는 `bot.command('help', ...)` 블록에 위치하며, 지원 명령어 목록을 사용자에게 안내한다.

현재 명령어 목록:
- `/help` — 도움말 표시
- `/ping` — 봇 응답 확인
- `/todo <내용>` — 새 todo 추가
- `/todos` — 대기/진행 중인 todo 목록 조회
- `/clear` — 완료/실패한 todo 삭제
- `/chatid` — Chat ID / User ID 확인

## 코드 스타일

- TypeScript strict 모드, ESM (`"type": "module"`, `NodeNext` resolution)
- 불변성 — 객체/배열 mutation 금지, spread로 새 객체 생성 (`messageBuffer = [...messageBuffer, item]`)
- Conventional commits: `feat:`, `fix:`, `refactor:`, `docs:`, `chore:`

## 런타임 데이터

`data/` 디렉토리 (gitignored):
- `sessions.json` — 세션 ID + 턴 카운트 (user/heartbeat 분리)
- `context.json` — 크로스 컨텍스트 공유 (lastUser, lastHeartbeat 요약)
- `pending_messages.json` — crash safety를 위한 메시지 백업
- `heartbeat.log`, `heartbeat.error.log` — 서비스 로그
