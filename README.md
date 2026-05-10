# 담배2026 재고관리 (Web App)

연동된 Google Sheets `담배2026`을 백엔드로 사용하는 가벼운 재고관리 웹앱입니다.
판매입력(바코드 스캔), 재고조회, 입출고 등록, 대시보드, CSV 일괄 업로드 기능을 제공합니다.

---

## 1. 사용한 시트 구조

스프레드시트 ID: `1Bfzg3V3GwprCaBUtZuHREWwdxnwR72nAxBBjQ_ZjrFw`

새로 생성한 시트(앱 전용):

| 시트명          | 용도                          | 컬럼                                                                                                   |
| --------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------ |
| `앱_상품마스터` | 상품 130건 (단일/보루 바코드) | 상품ID · 상품명 · 제조사 · 단일바코드 · 보루바코드 · 단일가격 · 보루가격 · 안전재고(보루) · 단종 · 비고 · 기초_단일 · 기초_보루 |
| `앱_판매기록`   | 판매 로그                     | 일시 · 상품ID · 상품명 · 단위 · 수량 · 단가 · 금액 · 메모 · 입력소스                                   |
| `앱_입출고`     | 입/출고/조정 로그             | 일시 · 상품ID · 상품명 · 구분 · 단위 · 수량 · 메모                                                     |
| `앱_설정`       | 글로벌 설정값                 | KEY · VALUE                                                                                            |

기존 월별 시트(2026.01 ~ 2026.12, 출고/기말재고 등)는 **삭제하지 않고 그대로 백업**으로 유지됩니다.

> 보루(Carton) = 10개 단일. 단일/보루 바코드는 별도이며 자동 인식됩니다.

---

## 2. Google Service Account 설정 (필수, 1회만)

쓰기(판매/입출고 저장)에는 서비스 계정이 필요합니다.

1. [Google Cloud Console](https://console.cloud.google.com/) → 프로젝트 생성(또는 기존 프로젝트 선택)
2. **API 및 서비스 → 라이브러리** → "Google Sheets API" 활성화
3. **API 및 서비스 → 사용자 인증 정보** → "사용자 인증 정보 만들기 → 서비스 계정"
4. 생성된 서비스 계정 → **키** 탭 → "키 추가 → JSON" → 키 파일 다운로드
5. 키 파일 안의 `client_email` (예: `xxx@yyy.iam.gserviceaccount.com`) 복사
6. [담배2026 시트](https://docs.google.com/spreadsheets/d/1Bfzg3V3GwprCaBUtZuHREWwdxnwR72nAxBBjQ_ZjrFw/edit)
   → 우측 상단 **공유** → 위 이메일 추가 → 권한 **편집자** → 알림 해제 → 보내기

이 두 가지(JSON 키, 시트 공유)만 끝나면 어디서 실행하든 동작합니다.

---

## 3. 실행 방법

### 옵션 A. 로컬 PC에서 실행

```bash
cd webapp
npm install

# 다운로드한 JSON 키 파일을 credentials.json 으로 저장
cp ~/Downloads/your-service-account.json credentials.json

npm start
# → http://localhost:5000
```

### 옵션 B. Cloudflare Pages + Workers (사용자 추천 방식)

1. 이 폴더(`webapp/`)를 GitHub 저장소에 push
2. Cloudflare 대시보드 → **Workers & Pages → Create application → Pages → Connect to Git**
3. 빌드 설정:
   - Build command: `npm install`
   - Build output: `public`
   - Root directory: `webapp`
4. **Settings → Environment variables**:
   - `GOOGLE_SERVICE_ACCOUNT_JSON` = (JSON 키 파일 내용 전체를 한 줄로 붙여넣기)
   - `SPREADSHEET_ID` = `1Bfzg3V3GwprCaBUtZuHREWwdxnwR72nAxBBjQ_ZjrFw`

> **참고:** Cloudflare Pages Functions는 Node 런타임(`googleapis`)을 직접 지원하지 않으므로,
> 백엔드는 **Render / Railway / Fly.io / Cloud Run** 같은 Node 호스팅이 더 간단합니다.
> 가장 빠른 방법: 아래 옵션 C.

### 옵션 C. Render.com (무료, 5분 배포)

1. GitHub에 push
2. [render.com](https://render.com) → New → Web Service → 저장소 연결
3. 설정:
   - Root Directory: `webapp`
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Environment Variables:
     - `GOOGLE_SERVICE_ACCOUNT_JSON` = JSON 키 내용
     - `SPREADSHEET_ID` (선택, 기본값 내장)

---

## 4. API 엔드포인트

| Method | Path                       | 설명                                                       |
| ------ | -------------------------- | ---------------------------------------------------------- |
| GET    | `/api/health`              | 서버 상태/인증 확인                                        |
| GET    | `/api/products`            | 상품 마스터 (캐시 60초, `?force=1`로 강제 갱신)            |
| GET    | `/api/products/lookup?barcode=` | 바코드 → 상품 매칭 (단일/보루 자동 판별)              |
| GET    | `/api/stock`               | 현재고 (기초+입고-판매-조정)                               |
| POST   | `/api/sales`               | 판매 1건 또는 배열로 기록                                  |
| POST   | `/api/inout`               | 입고/반품/출고조정/재고조정                                |
| GET    | `/api/sales?from=&to=&productId=` | 판매 내역 조회                                       |
| GET    | `/api/inout`               | 입출고 내역 조회                                           |
| GET    | `/api/dashboard`           | 일/주/월 매출 + TOP10 + 14일 일별 시계열                   |
| POST   | `/api/sales/bulk-csv`      | CSV(`일시,바코드,단위,수량,메모`) 일괄 업로드              |

---

## 5. 사용 흐름

1. **판매입력** 탭에서 바코드 스캔(또는 검색) → 단위/수량 → **담기** → 여러 건 누적 후 **저장하기**
2. **재고조회**에서 부족 상품 확인 → 발주
3. **입출고** 탭에서 받은 박스를 **입고**로 등록
4. POS CSV가 있으면 **CSV업로드**에서 일괄 반영
5. **대시보드**에서 일/주/월 매출과 베스트셀러 확인

모든 데이터는 Google Sheets `담배2026` 에 자동 누적되며, 시트에서 직접 수정해도 다음 새로고침 시 반영됩니다.

---

## 6. 폴더 구조

```
webapp/
├─ server/index.js        # Express + Google Sheets API
├─ public/
│  ├─ index.html          # SPA UI
│  ├─ app.js              # 프론트엔드 로직
│  └─ manifest.webmanifest
├─ secrets/credentials.json  # (선택) 서비스 계정 키 — gitignore에 등록
├─ render.yaml            # Render.com 배포 설정
├─ package.json
└─ README.md
```

---

## 7. Render.com 배포 (권장 호스팅)

### 1) 저장소 연결

1. [Render.com](https://render.com) 가입 → **New → Web Service**
2. **GitHub 저장소 연결** → `HankookM/tobacco2026` 선택
3. Render가 `render.yaml`을 자동 감지 → **Apply** 클릭

### 2) 환경 변수 설정 (1회)

Render 대시보드 → 서비스 → **Environment** 탭에서 추가:

| Key | Value |
| --- | --- |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | `secrets/credentials.json` 파일 **전체 내용**을 복붙 (한 줄로) |

`SPREADSHEET_ID`, `NODE_ENV`, `PORT`는 `render.yaml`에 이미 설정되어 있어 자동 적용됩니다.

### 3) 배포

- 첫 배포는 **Manual Deploy → Deploy latest commit** 클릭
- 이후부터는 GitHub `main`에 푸시하면 자동 배포
- 배포 URL: `https://tobacco2026.onrender.com` (또는 Render가 부여한 서브도메인)

### 4) 동작 확인

- `https://<your-url>/api/health` → `{"ok":true,"auth":"service-account"}`
- 루트 URL 접속 시 앱 화면 표시

### 무료 플랜 주의사항

- 15분간 트래픽 없으면 슬립 → 첫 요청 시 30~60초 콜드 스타트
- 월 750시간 무료 (단일 서비스 24/7 실행에 충분)
- 가게에서 항상 켜두려면 [Better Stack](https://betterstack.com/) 같은 무료 핑 서비스로 5분마다 깨우거나 유료 플랜($7/월)으로 전환
