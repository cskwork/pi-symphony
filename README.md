# Symphony for Pi

[Pi 코딩 에이전트](https://pi.dev)를 위한 증거 기반 소프트웨어 개발 워크플로 확장. 저장소 로컬 익스텐션 하나가 작업을 **Plan → Build → Review → Verify → Ready → Done** 까지 끌고 간다 — 내구성 있는 증거, 독립적인 fresh-context 리뷰어, 결정론적 검증, 크래시 세이프 복구와 함께.

```text
SYMPHONY  DEV-014 · BUILD · ● running
Fix pagination race · AC 2/3 · checks not run
```

## 설치

```bash
pi install git:github.com/cskwork/pi-symphony   # GitHub에서 설치
# 또는 npm 게시 후: pi install npm:@cskwork/pi-symphony
```

저장소 안에서:

```text
/sym init        # 저장소 점검, 체크 제안, .symphony/ 스캐폴딩 (프로젝트 스크립트 실행 없음)
/sym new         # 인수기준(acceptance criteria)과 리스크가 있는 작업 생성
/sym continue    # 유일한 액션: 다음 유효 단계로 진행
/sym             # 오버레이: 작업 목록 + 상세 (Overview/Contract/Changes/Review/Checks/History)
/sym doctor      # 설정·리스·복구 진단
/sym complete    # 통합 리비전에 대한 post-integration 검증
/sym web         # 로컬 HTML 컨트롤 플레인 (loopback, 토큰 인증)
```

## 워크플로

```text
/sym new → BACKLOG → PLAN → BUILD → REVIEW → VERIFY → READY
                                                    ↓ (직접 타깃 브랜치에 머지)
                                          POST-INTEGRATION VERIFY → DONE
```

모델이 우회할 수 없는 규칙:

- 모든 전환은 워크플로 그래프 **그리고** 출력 계약(output contract)에 대해 검증된다.
- 실패·타임아웃·불가·stale(리비전 불일치)한 필수 체크는 **Ready와 Done을 봉쇄**한다.
- 리뷰는 읽기 전용 도구와 경계된 매니페스트를 가진 **fresh 세션**에서 실행된다 — 구현자 트랜스크립트는 절대 전달되지 않는다.
- 재시작 시 진행 중이던 시도는 **Interrupted**로 표시된다. 자동 재개도 중복 실행도 없다.
- 작업 파일의 관리 마커 밖 인간 메모는 기계 쓰기가 발생해도 바이트 단위로 보존된다.

## 모델용 도구

| Tool | 용도 |
|---|---|
| `sym_task_read` | 작업 계약·리포트·상태 읽기 |
| `sym_diff_read` | 경계된 diff + 증거 매니페스트 |
| `sym_plan_submit` | 구조화된 플랜 (전환 여부는 엔진이 결정) |
| `sym_build_report` | 구조화된 구현 리포트 |
| `sym_review_submit` | 구조화된 리뷰 노트 (verdict + findings) |
| `sym_skills` / `sym_skill_select` | 스킬 카탈로그 / 본문 로드 (progressive disclosure) |

## 저장소 구조

```text
.symphony/
├── config.yaml               # schema v1/v2, 커밋됨
├── config.local.yaml         # 선택, gitignore된 표시 설정
├── tasks/DEV-014.md          # 작업당 하나의 markdown 레코드
├── skills/<name>/skill.yaml  # 컴포저블 스킬 (capability 선언)
├── evidence/DEV-014/         # checks/, review/, integration/ 아티팩트
└── runtime/                  # gitignore: events/, leases/, cache/
```

## 안전 모델

Symphony는 **당신의 사용자 권한으로 실행된다 — 샌드박스가 아니다.** 보호는 정책과 확인(confirm)이다:

- 체크는 실행파일 + 인자 배열(고정 `argv`)로만 정의된다. `shell:true` 금지. 환경변수는 allowlist, 시크릿은 증거 저장 전 레딕트.
- git은 읽기 전용 서브커맨드 allowlist(status/diff/rev-parse/log/branch/show/merge-base). push/merge/reset/clean은 실행 거부 — 통합은 설계상 수동.
- 보호 경로(`.env*`, `.git/**`, `.symphony/**`)의 쓰기는 차단 또는 확인 요구.
- 파괴적 셸 명령(`git push`, `reset --hard`, `rm -rf`, `sudo`, …)은 확인 요구.
- 리뷰어/위임 세션은 fresh + 읽기 전용 도구 + 턴 상한(fail-closed).

## 워크플로 커스터마이제이션 (v0.3)

저장소는 `config.yaml`(schema v2)에 검증된 스테이지 그래프를 정의할 수 있다: 타입화된 데이터 전용 조건(`task_kind`, `task_field`, `changed_paths`, `all/any/not`), 선언된 입출력, 승인·체크 게이트, 강제 불변식 — Done으로 가는 경로가 결정론적 검증을 우회하는 것은 불가능하고, 독립 리뷰 provenance는 선택 사항이 아니다. 스킬은 `.symphony/skills/<name>/skill.yaml`에 capability를 선언하며, 해시로 고정(pinning)되고 정책이 금지한 capability를 부여할 수 없다.

## 위임 & 핸드오프 (v0.4)

`/sym roles`는 활성 토폴로지(Quick/Standard/Deep)를 보여주고, `/sym delegate <role>`은 읽기 전용 fresh 세션(scout, architect, security_reviewer, qa_analyst, reviewer)을 실행한다 — 변경 불가능한 매니페스트(선언된 입력·도구·턴/시간 예산·명시적 제외 범위)와 함께. 결과는 내구성 있는 핸드오프 원장(해시로 검증된 봉투, 멱등 키, 역할/스테이지/시도/토폴로지 매칭 게이트, append-only 감사)으로 돌아온다.

## 워크트리 & 딜리버리 (v0.5)

관리형 워크트리가 위임 역할에 격리된 쓰기 면을 준다: 할당은 프리뷰 후에만, 경로는 저장소 밖으로 정규화, 브랜치는 결정론적·충돌 안전. 쓰기 소유권은 **fenced lease** — 원자적 CAS와 단조 증가 fencing token으로, 소유권 이전 후 낡은 리포트는 절대 수용되지 않는다. 딜리버리는 타입화·프리뷰·감사: preflight는 각 블로커를 분리해 보고하고, 체크 실패한 머지는 `IntegratedUnverified`로 처리(자동 리셋 없음, 명시적 처분 필요).

## 멀티 태스크 스케줄러 (v0.6)

작업은 검증된 의존성(`task_done`, `stage_reached`, `check_passed`)을 선언할 수 있다. 스케줄러는 결정론적이고(스냅샷의 순수 함수, 우선순위 → 에이징 → starvation bound), 디스패치는 멱등(intent → ack → reconcile → resolve), 어드미션은 all-or-nothing, 배타 리소스는 단일 소유자, 재시도는 분류(transient/deterministic/policy/user/unknown)되고 서킷 브레이커가 폭주를 막는다.

## 통합 & 관측성 (v0.8)

어댑터는 등록 전에 capability를 선언하고 정규화된 스냅샷만 반환한다 — 로컬 소유 필드의 원격 변경은 명시적 충돌이 되고, 원격 라벨은 검증된 커맨드로만 매핑된다(스테이지 점프 불가). 아웃바운드 뮤테이션은 타입화·승인 연결·멱등. CI 증거는 기대 head SHA에 대해 게이트. 익스포트는 기본 꺼짐, 사용량은 provider/estimated/unavailable을 구분(unavailable ≠ 0).

## 개발

```bash
npm install
npm test         # vitest — 유닛 + 통합 + wiring 스위트
npm run typecheck
npm run smoke:load   # 실제 pi 런타임에서 확장 로드 스모크
```

## 상태 — 1.0.1 (GA)

프로덕션 레디: 위 모든 게이트가 테스트로 강제된다 (323 tests / 37 files, typecheck 클린, 실-pi 스모크 5/5). `CHANGELOG.md`, `docs/`(버전별 리포트, 보안 모델, 위협 모델, 트러블슈팅) 참고.

**정직한 범위:** local-first, Pi-native, bounded, non-sandboxed, 자동 프로덕션 배포 없음. 안정성은 공개된 1.x 계약을 따른다.

---

English documentation: see `docs/` for per-version reports, the [security model](docs/security.md), [threat model](docs/threat-model.md), and [troubleshooting](docs/troubleshooting.md).
