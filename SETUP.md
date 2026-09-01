# 슬랙 앱 만들기 (처음 한 번만)

워크스페이스는 이미 있다고 가정합니다. 아래 순서대로 따라 하면 10분 정도 걸립니다.

---

## 1. 앱 만들기 (매니페스트 붙여넣기)

1. https://api.slack.com/apps 접속 → **Create New App**
2. **From a manifest** 선택 → 본인 워크스페이스 선택 → **Next**
3. **JSON** 탭을 누르고, 기본으로 들어 있는 내용을 지운 뒤 아래를 통째로 붙여넣기

```json
{
  "display_information": {
    "name": "밥머거",
    "description": "점심팟 모집부터 정산 계좌 DM까지",
    "background_color": "#4f46e5"
  },
  "features": {
    "bot_user": {
      "display_name": "밥머거",
      "always_online": true
    },
    "slash_commands": [
      {
        "command": "/배달",
        "description": "점심팟 모집을 시작합니다",
        "should_escape": false
      },
      {
        "command": "/외식",
        "description": "외식 모임을 시작합니다",
        "should_escape": false
      },
      {
        "command": "/내기빵",
        "description": "참가자 중 한 명을 뽑는 내기를 시작합니다",
        "should_escape": false
      },
      {
        "command": "/계좌등록",
        "description": "정산받을 내 계좌를 등록합니다",
        "should_escape": false
      }
    ]
  },
  "oauth_config": {
    "scopes": {
      "bot": ["commands", "chat:write", "chat:write.public", "im:write", "users:read"]
    }
  },
  "settings": {
    "interactivity": {
      "is_enabled": true
    },
    "org_deploy_enabled": false,
    "socket_mode_enabled": true,
    "token_rotation_enabled": false
  }
}
```

4. **Next** → **Create**

> **커맨드 이름을 바꾸고 싶다면**
> 매니페스트의 `command` 값과, `bot/index.ts` 의 `SLACK_LUNCH_COMMANDS` /
> `SLACK_ACCOUNT_COMMANDS` / `SLACK_DINE_OUT_COMMANDS` / `SLACK_BET_COMMANDS`
> 환경변수(또는 코드 기본값)가 **정확히 같아야** 합니다. 둘 중 하나만 바꾸면
> 슬랙이 커맨드를 보내줘도 봇이 무시해서 "아무 반응이 없는" 상태가 됩니다.

> **한글 커맨드가 거부된다면?**
> 슬랙이 한글 이름을 막는 경우가 있습니다. 그럴 땐 매니페스트와 위 환경변수를
> 함께 영문 이름(예: `/lunch`, `/account`)으로 바꾸세요.

> **이미 앱을 만들어 두셨다면?**
> 처음부터 다시 만들 필요 없습니다. 앱 화면 왼쪽 메뉴 맨 아래 **App Manifest** 로 가서
> **JSON** 탭의 내용을 위 매니페스트로 통째로 바꾸고 **Save Changes** 하세요.
> 그러면 권한과 슬래시 커맨드가 한 번에 맞춰집니다. 저장 후 뜨는 **Reinstall your app** 배너를 꼭 누르세요.

각 권한이 왜 필요한지:

| 권한                | 쓰이는 곳                                  |
| ------------------- | ------------------------------------------ |
| `commands`          | `/배달` · `/외식` · `/내기빵` · `/계좌등록` 슬래시 커맨드 |
| `chat:write`        | 모집 메시지 올리기 · 버튼 눌렀을 때 수정하기 |
| `chat:write.public` | 초대 안 된 공개 채널에도 메시지 올리기     |
| `im:write`          | **정산 계좌 DM 보내기** (이 프로젝트의 핵심) |
| `users:read`        | 사용자 이름 조회                           |

---

## 2. 토큰 두 개 발급받기

이 봇은 토큰이 **두 개** 필요합니다. 역할이 다릅니다.

### ① Bot Token (`xoxb-`) — 슬랙에 말을 걸 때 쓰는 열쇠

1. 왼쪽 메뉴 **OAuth & Permissions**
2. 맨 위 **Install to Workspace** (또는 **Reinstall**) 클릭 → **허용**
3. **Bot User OAuth Token** 값을 복사 (`xoxb-...`)

> ⚠️ **권한을 바꾼 뒤 재설치하면 이 토큰이 새로 발급될 수 있습니다.**
> 재설치했다면 여기서 값을 다시 확인하고, 달라졌으면 `.env.local` 을 고친 뒤 봇을 재시작하세요.
> (`xapp-` 토큰은 재설치와 무관하게 그대로입니다.)

### ② App-Level Token (`xapp-`) — 웹소켓으로 접속할 때 쓰는 열쇠

1. 왼쪽 메뉴 **Basic Information**
2. 아래로 스크롤 → **App-Level Tokens** → **Generate Token and Scopes**
3. 이름은 아무거나 (예: `socket`), **Add Scope** 에서 **`connections:write`** 선택
4. **Generate** → 나온 값을 복사 (`xapp-...`)

> 생성 직후 바로 복사해 두는 게 편합니다.
> (목록에서 토큰 이름을 다시 눌러 확인할 수도 있지만, 안 되면 새로 발급하면 됩니다.)

---

## 3. 토큰을 프로젝트에 넣기

```bash
cp .env.local.example .env.local
```

`.env.local` 을 열어 방금 복사한 두 값을 붙여넣습니다.

```
SLACK_BOT_TOKEN=xoxb-여기에-붙여넣기
SLACK_APP_TOKEN=xapp-여기에-붙여넣기
```

이 파일은 `.gitignore` 에 들어 있어서 깃에 올라가지 않습니다.

---

## 4. 실행

터미널 두 개를 씁니다.

**터미널 1 — 슬랙봇**

```bash
npm run bot
```

`🍚 점심팟 봇이 슬랙에 연결됐습니다.` 가 뜨면 성공입니다.

**터미널 2 — 관리자 대시보드 (선택)**

```bash
npm run dev
```

http://localhost:3000 에서 팟 현황을 볼 수 있습니다.

---

## 5. 채널에 봇 초대하고 써보기

슬랙에서 쓸 채널에 들어가 봇을 초대합니다.

```
/invite @밥머거
```

그리고 `/배달` 를 입력해 보세요.

---

## 잘 안 될 때

| 증상                                       | 원인과 해결                                                                 |
| ------------------------------------------ | --------------------------------------------------------------------------- |
| `invalid_auth`                             | `SLACK_BOT_TOKEN` 값이 틀렸습니다. `xoxb-` 로 시작하는지 확인하세요.        |
| 봇 실행 시 `connections:write` 관련 오류    | `xapp-` 토큰에 `connections:write` 권한을 안 준 경우입니다. 다시 발급하세요. |
| 슬래시 커맨드가 목록에 안 뜸               | 권한을 바꾼 뒤 **Reinstall to Workspace** 를 안 한 경우입니다.               |
| "채널에 메시지를 올리지 못했어요" DM이 옴  | 비공개 채널이라면 `/invite @밥머거` 로 봇을 초대해야 합니다.                 |
| 버튼을 눌러도 반응이 없음                  | `npm run bot` 터미널이 꺼져 있는지 확인하세요. 봇이 떠 있어야 버튼이 동작합니다. |
