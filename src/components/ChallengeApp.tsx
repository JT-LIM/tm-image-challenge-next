"use client";

import { useEffect, useMemo, useState } from "react";
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  writeBatch,
} from "firebase/firestore";
import { onAuthStateChanged, signInAnonymously, type User } from "firebase/auth";
import { firebaseStatus, getFirebaseClient } from "@/lib/firebase";
import type { ChallengeResult, ChallengeRoom, EvaluationPhoto, Submission } from "@/lib/types";
import {
  createRoomCode,
  normalizeModelUrl,
  normalizeRoomCode,
  normalizeText,
  parseLabels,
  scoreModel,
} from "@/lib/tm";

export default function ChallengeApp() {
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [roomCodeInput, setRoomCodeInput] = useState("");
  const [activeCode, setActiveCode] = useState("");
  const [room, setRoom] = useState<ChallengeRoom | null>(null);
  const [submissions, setSubmissions] = useState<Submission[]>([]);
  const [results, setResults] = useState<ChallengeResult[]>([]);
  const [photos, setPhotos] = useState<EvaluationPhoto[]>([]);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const firebase = useMemo(() => {
    if (!firebaseStatus.configured) return null;
    return getFirebaseClient();
  }, []);

  const isTeacher = Boolean(user && room && user.uid === room.teacherUid);

  useEffect(() => {
    if (!firebase) return;
    const unsub = onAuthStateChanged(firebase.auth, async (nextUser) => {
      if (nextUser) {
        setUser(nextUser);
        setAuthReady(true);
        return;
      }
      await signInAnonymously(firebase.auth);
    });
    return () => unsub();
  }, [firebase]);

  useEffect(() => {
    if (!firebase || !activeCode) return;
    const roomRef = doc(firebase.db, "rooms", activeCode);
    const unsubRoom = onSnapshot(roomRef, (snapshot) => {
      setRoom(snapshot.exists() ? ({ code: snapshot.id, ...snapshot.data() } as ChallengeRoom) : null);
      if (!snapshot.exists()) setNotice("방을 찾을 수 없어요. 코드를 다시 확인하세요.");
    });
    const unsubSubmissions = onSnapshot(
      query(collection(firebase.db, "rooms", activeCode, "submissions"), orderBy("createdAt", "asc")),
      (snapshot) => {
        setSubmissions(snapshot.docs.map((item) => ({ id: item.id, ...item.data() } as Submission)));
      }
    );
    const unsubResults = onSnapshot(
      query(collection(firebase.db, "rooms", activeCode, "results"), orderBy("rank", "asc")),
      (snapshot) => {
        setResults(snapshot.docs.map((item) => ({ id: item.id, ...item.data() } as ChallengeResult)));
      }
    );
    return () => {
      unsubRoom();
      unsubSubmissions();
      unsubResults();
    };
  }, [activeCode, firebase]);

  useEffect(() => {
    return () => {
      photos.forEach((photo) => URL.revokeObjectURL(photo.url));
    };
  }, [photos]);

  async function createRoom(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!firebase || !user) return;
    const form = new FormData(event.currentTarget);
    const title = normalizeText(String(form.get("title") || "")) || "이미지 모델 챌린지";
    const labels = parseLabels(String(form.get("labels") || ""));
    if (labels.length < 2) {
      setNotice("정답 라벨은 2개 이상 넣어주세요.");
      return;
    }

    setBusy(true);
    setNotice("");
    try {
      let code = createRoomCode();
      let roomRef = doc(firebase.db, "rooms", code);
      while ((await getDoc(roomRef)).exists()) {
        code = createRoomCode();
        roomRef = doc(firebase.db, "rooms", code);
      }
      await setDoc(roomRef, {
        title,
        labels,
        teacherUid: user.uid,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      setActiveCode(code);
      setRoomCodeInput(code);
      setNotice("방이 만들어졌어요. 학생들에게 방 코드를 알려주세요.");
      event.currentTarget.reset();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "방 만들기 실패");
    } finally {
      setBusy(false);
    }
  }

  function joinRoom(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const code = normalizeRoomCode(roomCodeInput);
    if (!code) {
      setNotice("방 코드를 입력하세요.");
      return;
    }
    setActiveCode(code);
    setRoomCodeInput(code);
    setNotice("");
  }

  async function submitModel(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!firebase || !user || !room) return;
    const form = new FormData(event.currentTarget);
    const teamName = normalizeText(String(form.get("teamName") || ""));
    const modelUrl = normalizeModelUrl(String(form.get("modelUrl") || ""));
    if (!teamName) {
      setNotice("팀 이름을 입력하세요.");
      return;
    }
    const existing = submissions.find((submission) => submission.ownerUid === user.uid);
    const payload = {
      teamName,
      modelUrl,
      ownerUid: user.uid,
      updatedAt: serverTimestamp(),
    };
    if (existing) {
      await updateDoc(doc(firebase.db, "rooms", room.code, "submissions", existing.id), payload);
    } else {
      await addDoc(collection(firebase.db, "rooms", room.code, "submissions"), {
        ...payload,
        createdAt: serverTimestamp(),
      });
    }
    setNotice("모델이 제출됐어요.");
  }

  async function removeSubmission(submissionId: string) {
    if (!firebase || !room) return;
    await deleteDoc(doc(firebase.db, "rooms", room.code, "submissions", submissionId));
  }

  function addPhotos(files: FileList | null) {
    if (!files) return;
    const nextPhotos = Array.from(files)
      .filter((file) => file.type.startsWith("image/"))
      .map((file) => ({
        id: `${file.name}-${crypto.randomUUID()}`,
        file,
        name: file.name.replace(/\.[^.]+$/, ""),
        url: URL.createObjectURL(file),
        answer: room?.labels[0] || "",
      }));
    setPhotos((current) => [...current, ...nextPhotos]);
  }

  function updatePhoto(photoId: string, patch: Partial<EvaluationPhoto>) {
    setPhotos((current) => current.map((photo) => (photo.id === photoId ? { ...photo, ...patch } : photo)));
  }

  function removePhoto(photoId: string) {
    setPhotos((current) => {
      const photo = current.find((item) => item.id === photoId);
      if (photo) URL.revokeObjectURL(photo.url);
      return current.filter((item) => item.id !== photoId);
    });
  }

  async function runScoring() {
    if (!firebase || !room || !isTeacher) return;
    if (!submissions.length) {
      setNotice("제출된 학생 모델이 없습니다.");
      return;
    }
    if (!photos.length || photos.some((photo) => !photo.answer)) {
      setNotice("평가 사진과 정답을 모두 넣어주세요.");
      return;
    }
    setBusy(true);
    setNotice("채점 중입니다. 모델 수가 많으면 시간이 조금 걸려요.");
    try {
      const scored = [];
      for (const submission of submissions) {
        const items = await scoreModel(submission.modelUrl, photos);
        const correct = items.filter((item) => item.correct).length;
        const averageConfidence = items.reduce((sum, item) => sum + item.confidence, 0) / items.length;
        scored.push({
          id: submission.id,
          teamName: submission.teamName,
          modelUrl: submission.modelUrl,
          score: Math.round((correct / items.length) * 100),
          correct,
          total: items.length,
          averageConfidence,
          misses: items.filter((item) => !item.correct),
        });
      }
      scored.sort((a, b) => b.score - a.score || b.averageConfidence - a.averageConfidence || a.teamName.localeCompare(b.teamName));
      const batch = writeBatch(firebase.db);
      results.forEach((result) => {
        batch.delete(doc(firebase.db, "rooms", room.code, "results", result.id));
      });
      scored.forEach((result, index) => {
        batch.set(doc(firebase.db, "rooms", room.code, "results", result.id), {
          ...result,
          rank: index + 1,
          updatedAt: serverTimestamp(),
        });
      });
      await batch.commit();
      setNotice("채점이 완료됐어요. 학생 화면에도 순위가 보입니다.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "채점 실패");
    } finally {
      setBusy(false);
    }
  }

  if (!firebaseStatus.configured) {
    return <FirebaseSetup missingKeys={firebaseStatus.missingKeys} />;
  }

  return (
    <main className="app-shell">
      <section className="hero">
        <div className="hero-copy">
          <p className="eyebrow">Live Teachable Machine Challenge</p>
          <h1>우리 반 AI 모델, 실시간으로 겨뤄보자</h1>
          <p className="hero-description">
            학생들이 만든 이미지 모델 링크를 제출하면 선생님이 올린 평가 사진으로 바로 채점하고 순위를 공유합니다.
          </p>
          <div className="hero-actions">
            <form className="join-form" onSubmit={joinRoom}>
              <input
                value={roomCodeInput}
                onChange={(event) => setRoomCodeInput(normalizeRoomCode(event.target.value))}
                placeholder="방 코드 입력"
                aria-label="방 코드"
              />
              <button type="submit">입장하기</button>
            </form>
            <div className={`status-pill ${authReady ? "ready" : "loading"}`}>
              <span aria-hidden="true" />
              {authReady ? "접속 준비 완료" : "익명 접속 준비 중"}
            </div>
          </div>
        </div>
        <div className="hero-card" aria-label="수업 진행 순서">
          <div className="hero-card-top">
            <span>CLASSROOM AI</span>
            {room ? <strong>{room.code}</strong> : <strong>READY</strong>}
          </div>
          <div className="hero-steps">
            <span>1. 방 만들기</span>
            <span>2. 모델 제출</span>
            <span>3. 사진 채점</span>
          </div>
          <div className="hero-score">
            <strong>{results[0]?.score ?? 0}</strong>
            <span>현재 최고점</span>
          </div>
        </div>
      </section>

      {room && (
        <section className="control-band">
          <div className="room-code">
            <span>현재 방 코드</span>
            <strong>{room.code}</strong>
          </div>
          <div className="room-meta">
            <span>{submissions.length}팀 제출</span>
            <span>{results.length}팀 채점 완료</span>
          </div>
        </section>
      )}

      {notice && <div className="notice">{notice}</div>}

      {!room && (
        <section className="panel create-room">
          <div>
            <span className="section-kicker">Teacher room</span>
            <h2>교사용 방 만들기</h2>
            <p>라벨 이름은 학생들이 Teachable Machine에서 만든 클래스 이름과 같아야 채점이 정확합니다.</p>
            <div className="tip-grid">
              <span>학생은 모델 링크만 제출</span>
              <span>사진은 선생님 브라우저에만 보관</span>
              <span>결과는 모든 접속자에게 실시간 공유</span>
            </div>
          </div>
          <form onSubmit={createRoom} className="create-form">
            <label>
              <span>수업 이름</span>
              <input name="title" placeholder="예: 3반 분리수거 모델 대회" />
            </label>
            <label>
              <span>정답 라벨</span>
              <textarea name="labels" rows={4} placeholder="라벨을 쉼표나 줄바꿈으로 입력&#10;예: paper, plastic, can" />
            </label>
            <button type="submit" disabled={!authReady || busy}>새 방 만들기</button>
          </form>
        </section>
      )}

      {room && (
        <section className="workspace-grid">
          <section className="panel student-panel">
            <div className="panel-head">
              <div>
                <span className="section-kicker">{isTeacher ? "Teacher" : "Student"}</span>
                <h2>{room.title}</h2>
                <p>{isTeacher ? "교사 화면" : "학생 화면"}</p>
              </div>
              <span className="badge">{submissions.length}팀 제출</span>
            </div>
            <div className="label-row">
              {room.labels.map((label) => <span key={label}>{label}</span>)}
            </div>
            {!isTeacher && (
              <form className="model-form" onSubmit={submitModel}>
                <input name="teamName" placeholder="팀 이름" defaultValue={submissions.find((item) => item.ownerUid === user?.uid)?.teamName || ""} />
                <input name="modelUrl" placeholder="Teachable Machine 모델 링크" defaultValue={submissions.find((item) => item.ownerUid === user?.uid)?.modelUrl || ""} />
                <button type="submit">모델 제출</button>
              </form>
            )}
            <SubmissionList submissions={submissions} isTeacher={isTeacher} onRemove={removeSubmission} />
          </section>

          {isTeacher && (
            <section className="panel teacher-panel">
              <div className="panel-head">
                <div>
                    <span className="section-kicker">Scoring photos</span>
                  <h2>평가 사진</h2>
                  <p>정답 사진은 선생님 브라우저에만 머뭅니다.</p>
                </div>
                <span className="badge">{photos.length}장</span>
              </div>
              <label className="drop-zone">
                <input type="file" accept="image/*" multiple onChange={(event) => addPhotos(event.target.files)} />
                <strong>평가 사진 선택</strong>
                <span>여러 장을 한 번에 올릴 수 있어요</span>
              </label>
              <div className="photo-grid">
                {photos.map((photo) => (
                  <article className="photo-card" key={photo.id}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={photo.url} alt={photo.name} />
                    <input value={photo.name} onChange={(event) => updatePhoto(photo.id, { name: event.target.value })} aria-label="사진 이름" />
                    <select value={photo.answer} onChange={(event) => updatePhoto(photo.id, { answer: event.target.value })} aria-label="정답">
                      {room.labels.map((label) => <option key={label} value={label}>{label}</option>)}
                    </select>
                    <button type="button" onClick={() => removePhoto(photo.id)}>삭제</button>
                  </article>
                ))}
              </div>
              <button className="score-button" type="button" onClick={runScoring} disabled={busy}>
                {busy ? "채점 중" : "전체 채점 시작"}
              </button>
            </section>
          )}

          <section className="panel results-panel">
            <div className="panel-head">
              <div>
                <span className="section-kicker">Leaderboard</span>
                <h2>실시간 순위</h2>
                <p>교사가 채점하면 모든 접속자에게 결과가 표시됩니다.</p>
              </div>
              <span className="badge">{results.length}팀</span>
            </div>
            <ResultsTable results={results} />
          </section>
        </section>
      )}
    </main>
  );
}

function FirebaseSetup({ missingKeys }: { missingKeys: string[] }) {
  const envNames: Record<string, string> = {
    apiKey: "NEXT_PUBLIC_FIREBASE_API_KEY",
    authDomain: "NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN",
    projectId: "NEXT_PUBLIC_FIREBASE_PROJECT_ID",
    storageBucket: "NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET",
    messagingSenderId: "NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID",
    appId: "NEXT_PUBLIC_FIREBASE_APP_ID",
  };

  return (
    <main className="app-shell narrow">
      <section className="panel setup-warning">
        <p className="eyebrow">Firebase setup needed</p>
        <h1>Firebase 설정을 넣으면 실시간 방이 열립니다</h1>
        <p>아래 키들을 `.env.local`과 Vercel 환경 변수에 넣어주세요.</p>
        <pre>{missingKeys.map((key) => envNames[key] || key).join("\n")}</pre>
      </section>
    </main>
  );
}

function SubmissionList({ submissions, isTeacher, onRemove }: {
  submissions: Submission[];
  isTeacher: boolean;
  onRemove: (submissionId: string) => void;
}) {
  if (!submissions.length) {
    return <p className="empty">아직 제출된 모델이 없습니다.</p>;
  }
  return (
    <div className="submission-list">
      {submissions.map((submission) => (
        <article key={submission.id} className="submission-card">
          <div>
            <strong>{submission.teamName}</strong>
            <span>{submission.modelUrl}</span>
          </div>
          {isTeacher && <button type="button" onClick={() => onRemove(submission.id)}>삭제</button>}
        </article>
      ))}
    </div>
  );
}

function ResultsTable({ results }: { results: ChallengeResult[] }) {
  if (!results.length) {
    return <p className="empty">아직 채점 결과가 없습니다.</p>;
  }
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>순위</th>
            <th>팀</th>
            <th>점수</th>
            <th>정답</th>
            <th>평균 확신도</th>
            <th>오답</th>
          </tr>
        </thead>
        <tbody>
          {results.map((result) => (
            <tr key={result.id}>
              <td><span className="rank-badge">{result.rank}</span></td>
              <td>{result.teamName}</td>
              <td><strong>{result.score}점</strong></td>
              <td>{result.correct}/{result.total}</td>
              <td>{Math.round(result.averageConfidence * 100)}%</td>
              <td>
                {result.misses.length
                  ? result.misses.map((miss) => `${miss.photoName}: ${miss.answer} → ${miss.predicted || "실패"}`).join(", ")
                  : "없음"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
