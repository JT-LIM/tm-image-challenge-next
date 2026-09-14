# TM 이미지 모델 채점방

학생들이 각자 Teachable Machine 이미지 모델을 만들고, 같은 방 코드로 접속해 모델 링크를 제출하면 교사가 한 번에 채점하는 Next.js + Firebase 앱입니다.

## 기능

- 교사: 방 생성, 라벨 등록, 제출 목록 확인, 평가 사진 업로드, 전체 채점
- 학생: 방 코드로 입장, 팀 이름과 Teachable Machine 모델 링크 제출
- 모두: 실시간 제출 목록과 순위표 확인
- 데이터 저장: Firestore
- 사진 저장: 저장하지 않음. 평가 사진은 교사 브라우저 안에서만 사용됩니다.

## Firebase 설정

Firebase Console에서 다음을 켭니다.

1. Authentication > Sign-in method > Anonymous 활성화
2. Firestore Database 생성
3. Project settings > Web app 추가 후 Firebase config 복사
4. Firestore Rules에 `firestore.rules` 내용 배포

`.env.local` 파일을 만들고 아래 값을 채웁니다.

```bash
NEXT_PUBLIC_FIREBASE_API_KEY=
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=
NEXT_PUBLIC_FIREBASE_PROJECT_ID=
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=
NEXT_PUBLIC_FIREBASE_APP_ID=
```

Vercel에 배포할 때도 같은 환경 변수를 Project Settings > Environment Variables에 넣으면 됩니다.

## 실행

```bash
npm install
npm run dev
```

Next.js 16과 Firebase 12를 사용하므로 Node.js 20.9 이상이 필요합니다.

## 채점 규칙

Teachable Machine의 클래스 이름과 교사가 만든 라벨 이름이 같아야 정답으로 인정됩니다. 예를 들어 라벨이 `paper`, `plastic`, `can`이면 학생 모델의 클래스 이름도 같은 문자열을 사용해야 합니다.
