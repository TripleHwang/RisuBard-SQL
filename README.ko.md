<p align="center">
  <a href="README.md">English</a> · <strong>한국어</strong>
</p>

<h1 align="center">
  <img src="assets/readme/risubard-hero.png" alt="RisuBard — Dynamic Memory-Driven AI Chat App" width="900">
</h1>

<p align="center">
  고정 예산 서사 메모리를 사용하는 셀프 호스팅 AI 캐릭터 채팅 프론트엔드
</p>

<p align="center">
  <a href="https://github.com/rpaddict/RisuBard/releases"><img alt="GitHub Release" src="https://img.shields.io/github/v/release/rpaddict/RisuBard?display_name=tag&sort=semver"></a>
  <a href="https://github.com/rpaddict/RisuBard/actions/workflows/pr-check.yml"><img alt="빌드 상태" src="https://github.com/rpaddict/RisuBard/actions/workflows/pr-check.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="라이선스: GPL-3.0-only" src="https://img.shields.io/badge/license-GPL--3.0--only-blue.svg"></a>
</p>

<p align="center">
  <strong><a href="https://github.com/rpaddict/RisuBard/releases">다운로드</a></strong> ·
  <a href="docs/ko/install.md">설치</a> ·
  <a href="docs/ko/migration.md">RisuAI에서 이전</a> ·
  <a href="https://github.com/rpaddict/RisuBard/issues">이슈</a>
</p>

RisuBard는 모델의 컨텍스트 창보다 오래 이어지는 캐릭터 채팅을 위해 만들어졌습니다. 원본 대화는 근거로 보존하고, 장기 서사 상태는 Obsidian 호환 Markdown에 기록하며, 매 요청에는 관련된 기억만 명시적인 예산 안에서 선별해 넣습니다.

기존 RisuAI 생태계의 캐릭터, CHARX 카드, 로어북, 모듈, 프롬프트 프리셋, 모델 제공자와 플러그인 연결 경로를 유지하면서 파일 정본 저장 구조와 지속적인 이야기를 위한 장기 메모리를 제공합니다.

> RisuBard는 AI 모델을 포함하거나 호스팅하지 않습니다. 사용자가 관리하는 로컬 모델 또는 원격 모델 제공자를 연결해 사용합니다.

## 목차

- [왜 RisuBard인가?](#왜-risubard인가)
- [작동 방식](#작동-방식)
- [주요 특징](#주요-특징)
- [빠른 시작](#빠른-시작)
- [호환성과 데이터 이전](#호환성과-데이터-이전)
- [데이터와 개인정보](#데이터와-개인정보)
- [문서](#문서)
- [기여](#기여)
- [계보와 라이선스](#계보와-라이선스)

## 왜 RisuBard인가?

<p align="center">
  <img src="assets/readme/why-risubard-01.png" alt="길어진 전체 스토리를 매번 읽느라 비용과 기억 한계에 부딪힌 AI" width="900">
</p>

<p align="center">
  <img src="assets/readme/why-risubard-02.png" alt="한 페이지를 쓸 때마다 책 네 권을 다시 외우는 어려움을 설명하는 AI" width="900">
</p>

<p align="center">
  <img src="assets/readme/why-risubard-03.png" alt="핵심 정보는 메모하고 필요한 세부 정보만 찾아보자고 설명하는 리스바드" width="900">
</p>

<p align="center">
  <img src="assets/readme/why-risubard-04.png" alt="사건과 인물을 위키에 기록하고 갱신하는 RisuBard 작업 방식" width="900">
</p>

캐릭터 채팅이 길어지면 피할 수 없는 제약에 도달합니다. 모델 요청은 영원히 커질 수 없습니다. 전체 대화를 매번 다시 보내는 방식은 갈수록 비싸지고 결국 모델의 컨텍스트 창을 넘습니다. 과거를 하나의 누적 요약으로 대체하면 크기는 줄지만 중요한 상태, 인과관계와 캐릭터별 지식이 사라질 수 있습니다.

RisuBard는 세 가지 책임을 분리합니다.

- **원본 채팅**은 근거와 기록으로 보존합니다.
- **BardWiki**는 지속되는 서사 상태를 읽을 수 있는 Markdown으로 저장합니다.
- **모델 컨텍스트**는 매 요청마다 명시적인 토큰 상한 안에서 컴파일합니다.

따라서 저장된 대화가 계속 늘어나더라도 프롬프트 예산이 함께 증가하지 않습니다.

## 작동 방식

```text
확정된 대화
  ├─ 원본 메시지는 근거로 보존
  └─ 지속되는 사건과 상태는 Markdown BardWiki에 반영

다음 모델 요청
  ├─ 캐릭터와 세계관 기반
  ├─ 현재 장면
  ├─ 관련 BardWiki 문서
  ├─ 제한된 최근 원문 메시지
  └─ 현재 사용자 입력
             │
             ▼
       고정 예산 컴파일러
             │
             ▼
      사용자가 설정한 모델
```

필수 컨텍스트는 조용히 버리지 않습니다. 선택 자료는 관련도와 우선순위에 따라 고르고, 채팅 길이나 위키 크기가 커져도 예산은 자동으로 늘어나지 않습니다. 요청 manifest는 API 키나 숨겨진 사고 과정을 기록하지 않으면서 무엇이 포함·제외·축소되었는지 보여줍니다.

## 주요 특징

### 고정 예산 서사 메모리

- 최근 메시지, 선택 메모리, 분석 입력과 응답 예약량에 명시적인 상한 적용
- 전체 기록 재전송 대신 요청마다 관련 기억 선별
- 메모리 inquiry가 실패해도 캐릭터 기반과 최근 메시지로 안전하게 진행

### Markdown BardWiki

- 캐릭터, 장소, 세력, 사물, 개념, 장면과 사건을 Obsidian 호환 Markdown으로 저장
- 자동 서사 분석과 사용자의 직접 편집을 함께 지원
- 문서별 `always`, `auto`, `never` 컨텍스트 정책
- history, snapshot, 휴지통, 건강도 검사와 hash 기반 충돌 방지

### 파일 정본 사용자 데이터

- SQLite나 하나의 데이터베이스 BLOB 대신 JSON, JSONL, Markdown과 content-addressed 에셋 사용
- 캐릭터, 채팅, 에셋과 인덱스의 지연 로딩
- 원자 저장, 복구 가능한 journal, revision과 휴지통 삭제
- 기존 클라이언트와 내보내기를 위한 재생성 가능한 호환 투영본

### RisuAI 생태계 호환성

- CHARX 캐릭터 카드, 로어북, 모듈, 프롬프트 프리셋과 기존 모델 제공자 경로
- 기존 `.bin`, save 폴더와 선택적인 `risuai.db` 이전 경로
- 기존 워크플로로 데이터를 옮길 수 있는 호환 내보내기
- 기존 모듈과 플러그인 연결 경계 유지

### 셀프 호스팅과 포터블 배포

- Windows x64, Linux x64/ARM64, macOS Apple Silicon용 포터블 패키지
- Docker, 소스 설치와 Android Termux 가이드
- 포터블 패키지의 선택적 업데이트 알림과 셀프 업데이트

## 빠른 시작

포터블 패키지는 RisuBard를 실행하는 가장 간단한 방법이며 Node.js나 Docker가 필요하지 않습니다.

1. [GitHub Releases](https://github.com/rpaddict/RisuBard/releases)를 엽니다.
2. 운영체제에 맞는 패키지를 내려받아 압축을 풉니다.
3. RisuBard를 실행하고 `http://localhost:6001`을 엽니다.

| 플랫폼 | 패키지 | 실행 |
| --- | --- | --- |
| Windows x64 | `RisuBard-vX.Y.Z-win-x64.zip` | `RisuBard.exe` 더블클릭 |
| Linux x64 | `RisuBard-vX.Y.Z-linux-x64.tar.gz` | `./start.sh` 실행 |
| Linux ARM64 | `RisuBard-vX.Y.Z-linux-arm64.tar.gz` | `./start.sh` 실행 |
| macOS Apple Silicon | `RisuBard-vX.Y.Z-macos-arm64.tar.gz` | `RisuBard.app` 열기 |

Docker, 소스 빌드, 원격 접속, 업데이트와 플랫폼별 요구사항은 [전체 설치 가이드](docs/ko/install.md)를 참고하세요.

## 호환성과 데이터 이전

RisuBard는 기존 컬렉션을 버리지 않고 확장할 수 있도록 설계했습니다. 일반 RisuAI `.bin` 백업, 압축한 Node save 폴더 또는 대용량 설치를 위한 save 폴더 직접 복사를 지원합니다.

이전하기 전에 원본 설치를 백업한 다음 [RisuAI 데이터 이전 가이드](docs/ko/migration.md)를 따르세요. 가져온 데이터는 활성 상태를 교체하기 전에 검증하며, 기존 `risuai.db`는 선택적인 일회성 추출 전에 migration backup으로 복사합니다.

호환성은 릴리스 게이트입니다. 자동화된 테스트가 백업 왕복, cold storage, remote block, 설정 전용 내보내기, 레거시 프리셋, CHARX 관련 적용 경로, 모듈과 플러그인을 검증합니다.

## 데이터와 개인정보

RisuBard는 사용자가 관리하는 환경에서 실행되며 사용자 데이터 정본을 데이터 루트 아래의 일반 파일로 저장합니다. `RISUBARD_DATA_ROOT`로 별도의 절대 경로를 지정할 수 있으므로 앱 코드와 사용자 데이터를 같은 디렉터리에 둘 필요가 없습니다.

모델 통신은 사용자가 설정한 제공자를 따릅니다. 원격 모델 제공자에 보낸 요청에는 해당 제공자의 데이터 정책이 적용되며, 로컬 모델 요청은 사용자가 운영하는 환경 안에 머뭅니다. RisuBard의 요청 로그는 요청·응답 본문, 인증 헤더, URL, API 키와 숨겨진 사고 과정을 기록하지 않습니다.

저장 트리, 강제 종료 안전성, 백업 동작과 Termux 제약은 [파일 정본 사용자 데이터](docs/ko/file-native-storage.md)를 참고하세요.

## 문서

| 주제 | 한국어 | English |
| --- | --- | --- |
| 설치와 업데이트 | [설치](docs/ko/install.md) | [Installation](docs/en/install.md) |
| RisuAI에서 이전 | [데이터 이전](docs/ko/migration.md) | [Migration](docs/en/migration.md) |
| BardWiki 메모리 | [메모리 사용 안내](docs/ko/memory-wiki.md) | — |
| 파일 정본 저장 | [파일 정본 저장](docs/ko/file-native-storage.md) | [Storage](docs/en/file-native-storage.md) |
| 원격 접속 | [원격 접속](docs/ko/remote.md) | [Remote access](docs/en/remote.md) |
| Android | [Termux](docs/ko/termux.md) | [Termux](docs/en/termux.md) |
| 아키텍처 | [Code boundaries](docs/architecture/code-boundaries.md) | [Code boundaries](docs/architecture/code-boundaries.md) |

`docs/de`, `docs/cn`, `docs/es`, `docs/vi`, `docs/zh-Hant`에도 번역된 설치·이전 문서가 있습니다.

## 프로젝트 상태

RisuBard는 활발하게 개발 중입니다. 중요한 데이터를 이전하기 전에 최신 백업을 만들고, 저장 또는 호환성에 영향을 주는 변경은 [릴리스 노트](https://github.com/rpaddict/RisuBard/releases)에서 확인하세요.

저장소는 Svelte·TypeScript 검사, 브라우저·서버 단위 테스트, 호환성 왕복 테스트와 프로덕션 빌드로 릴리스를 검증합니다.

## 기여

이슈, 설계 토론, 문서 개선, 테스트와 Pull Request를 환영합니다. 동작이나 아키텍처를 크게 바꾸는 작업은 구현 전에 이슈를 열어 호환성과 이전 요구사항을 먼저 합의해 주세요.

코드를 제출하기 전에 다음 명령을 실행합니다.

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm test:compat
pnpm build
```

명시적인 이전 경로가 없는 변경은 기존 CHARX, 모듈, 플러그인, 프리셋과 가져오기·내보내기 호환성을 보존해야 합니다.

## 계보와 라이선스

RisuBard는 GPLv3 RisuAI 코드에서 출발했으며 해당 프로젝트의 라이선스 의무와 저작자 표시를 유지합니다. 독립적으로 작성된 RisuBard 구성요소는 문서화된 코드 경계 뒤에 두어 구조가 발전해도 코드의 계보를 확인할 수 있게 합니다.

이 저장소는 **GNU General Public License v3.0 only**로 배포됩니다. [LICENSE](LICENSE), [NOTICE.md](NOTICE.md)와 [코드 경계 아키텍처](docs/architecture/code-boundaries.md)를 참고하세요.
