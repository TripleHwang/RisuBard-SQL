# RisuVault v0.3.1 실제 기기 검증 결과

상태: **iOS 사양 지원, 실제 iPhone 미검증; Android 실기기 검증은 릴리스 후 계획됨**. 이 문서는 결과 기록용이며, 아직 어떤 기기 검증도 통과로 표시하지 않습니다.

| Device/build | Safari/PWA 또는 Chrome | 데이터 프로필 | 서버 max RSS | 결과 |
| --- | --- | --- | --- | --- |
| 미기록 | 미기록 | 200 characters / 20,000 messages / logical 20 GiB assets | 미기록 | 미실행 |

## 시작 시간 (10 cold starts)

| 실행 | ms |
| --- | --- |
| 1–10 | 미기록 |

## 관찰 및 게이트

| 항목 | 값 | 결과 |
| --- | --- | --- |
| startup p95 | 미기록 | 미실행 |
| chat selection p95 | 미기록 | 미실행 |
| forced reload count | 미기록 | 미실행 |
| draft-loss count | 미기록 | 미실행 |
| WebKit termination | 미기록 | 미실행 |
| 업로드/asset processing 취소 | 미기록 | 미실행 |
| cleanup verification (staging/orphaned assets) | 미기록 | 미실행 |

첨부할 증거는 content-free performance-report JSON, 서버 max RSS, pass/fail 관찰뿐입니다. 사용자 콘텐츠는 포함하지 않습니다.
