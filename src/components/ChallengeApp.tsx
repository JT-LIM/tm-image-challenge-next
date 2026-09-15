"use client";

import { useEffect, useMemo, useState } from "react";
import {
  addDoc,
  collection,
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

export default function ChallengeApp({ adminMode = false }: { adminMode?: boolean }) {
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [roomCodeInput, setRoomCodeInput] = useState("");
  const [activeCode, setActiveCode] = useState("");
  const [room, setRoom] = useState<ChallengeRoom | null>(null);
  const [submissions, setSubmissions] = useState<Submission[]>([]);
  const [results, setResults] = useState<ChallengeResult[]>([]);
  const [challengePhoto, setChallengePhoto] = useState<EvaluationPhoto | null>(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const firebase = useMemo(() => {
    if (!firebaseStatus.configured) return null;
    return getFirebaseClient();
  }, []);

  const isTeacher = Boolean(user && room && user.uid === room.teacherUid);
  const canManageRoom = adminMode && isTeacher;
  const canSubmitModel = Boolean(room && !adminMode);

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
      if (challengePhoto) URL.revokeObjectURL(challengePhoto.url);
    };
  }, [challengePhoto]);

  async function createRoom(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!firebase || !user) return;
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
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
      formElement.reset();
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
    const batch = writeBatch(firebase.db);
    batch.delete(doc(firebase.db, "rooms", room.code, "submissions", submissionId));
    if (isTeacher) batch.delete(doc(firebase.db, "rooms", room.code, "results", submissionId));
    await batch.commit();
  }

  function setScoringPhoto(files: FileList | null) {
    const file = Array.from(files || []).find((item) => item.type.startsWith("image/"));
    if (!file) return;
    setChallengePhoto((current) => {
      if (current) URL.revokeObjectURL(current.url);
      return {
        id: `${file.name}-${crypto.randomUUID()}`,
        file,
        name: file.name.replace(/\.[^.]+$/, ""),
        url: URL.createObjectURL(file),
        answer: room?.labels[0] || "",
      };
    });
  }

  function updateScoringPhoto(patch: Partial<EvaluationPhoto>) {
    setChallengePhoto((current) => (current ? { ...current, ...patch } : current));
  }

  function clearScoringPhoto() {
    setChallengePhoto((current) => {
      if (current) URL.revokeObjectURL(current.url);
      return null;
    });
  }

  async function runScoring() {
    if (!firebase || !room || !isTeacher) return;
    if (!submissions.length) {
      setNotice("제출된 학생 모델이 없습니다.");
      return;
    }
    if (!challengePhoto?.answer) {
      setNotice("채점할 사진과 정답을 넣어주세요.");
      return;
    }
    setBusy(true);
    setNotice("사진 한 장으로 전체 모델을 채점 중입니다.");
    try {
      const scored = [];
      for (const submission of submissions) {
        const previous = results.find((result) => result.id === submission.id);
        const [item] = await scoreModel(submission.modelUrl, [challengePhoto]);
        const previousTotal = previous?.total || 0;
        const previousCorrect = previous?.correct || 0;
        const total = previousTotal + 1;
        const correct = previousCorrect + (item.correct ? 1 : 0);
        const averageConfidence = ((previous?.averageConfidence || 0) * previousTotal + item.confidence) / total;
        scored.push({
          id: submission.id,
          teamName: submission.teamName,
          modelUrl: submission.modelUrl,
          score: correct,
          correct,
          total,
          averageConfidence,
          misses: item.correct ? (previous?.misses || []) : [item, ...(previous?.misses || [])].slice(0, 5),
          lastAnswer: item.answer,
          lastPredicted: item.predicted,
          lastConfidence: item.confidence,
          lastCorrect: item.correct,
        });
      }
      scored.sort((a, b) => b.score - a.score || b.averageConfidence - a.averageConfidence || a.teamName.localeCompare(b.teamName));
      const batch = writeBatch(firebase.db);
      scored.forEach((result, index) => {
        batch.set(doc(firebase.db, "rooms", room.code, "results", result.id), {
          ...result,
          rank: index + 1,
          updatedAt: serverTimestamp(),
        });
      });
      await batch.commit();
      const winners = scored.filter((result) => result.lastCorrect).map((result) => result.teamName);
      setNotice(winners.length ? `이번 사진 정답 팀: ${winners.join(", ")}` : "이번 사진을 맞춘 팀이 없습니다.");
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
          <p className="eyebrow">{adminMode ? "Teacher Admin" : "Live Teachable Machine Challenge"}</p>
          <h1>{adminMode ? "선생님용 AI 챌린지 관리자" : "우리 반 AI 모델, 실시간으로 겨뤄보자"}</h1>
          <p className="hero-description">
            {adminMode
              ? "방을 만들고, 사진 한 장을 바로 채점해 맞춘 팀의 점수를 실시간으로 올립니다."
              : "선생님이 알려준 방 코드로 들어와 Teachable Machine 이미지 모델 링크를 제출하세요."}
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
            <span>{adminMode ? "1. 방 만들기" : "1. 방 코드 받기"}</span>
            <span>{adminMode ? "2. 제출 확인" : "2. 모델 제출"}</span>
            <span>{adminMode ? "3. 바로 채점" : "3. 순위 확인"}</span>
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
            <span>{results[0]?.total || 0}문제 진행</span>
          </div>
        </section>
      )}

      {notice && <div className="notice">{notice}</div>}

      {!room && adminMode && (
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

      {!room && !adminMode && (
        <section className="panel student-welcome">
          <div>
            <span className="section-kicker">Student entrance</span>
            <h2>학생은 방 코드로만 입장해요</h2>
            <p>선생님이 만든 방 코드 6자리를 입력하면 팀 이름과 Teachable Machine 모델 링크를 제출할 수 있습니다.</p>
          </div>
          <div className="student-guide-grid">
            <article>
              <strong>1</strong>
              <span>선생님에게 방 코드를 받기</span>
            </article>
            <article>
              <strong>2</strong>
              <span>팀 이름과 모델 링크 제출하기</span>
            </article>
            <article>
              <strong>3</strong>
              <span>채점 후 실시간 순위 확인하기</span>
            </article>
          </div>
        </section>
      )}

      {room && (
        <section className={`workspace-grid ${canManageRoom ? "" : "student-workspace"}`}>
          <section className="panel student-panel">
            <div className="panel-head">
              <div>
                <span className="section-kicker">{canManageRoom ? "Teacher" : "Student"}</span>
                <h2>{room.title}</h2>
                <p>{canManageRoom ? "교사 화면" : "학생 화면"}</p>
              </div>
              <span className="badge">{submissions.length}팀 제출</span>
            </div>
            <div className="label-row">
              {room.labels.map((label) => <span key={label}>{label}</span>)}
            </div>
            {canSubmitModel && (
              <form className="model-form" onSubmit={submitModel}>
                <input name="teamName" placeholder="팀 이름" defaultValue={submissions.find((item) => item.ownerUid === user?.uid)?.teamName || ""} />
                <div className="model-link-row">
                  <input name="modelUrl" placeholder="Teachable Machine 모델 링크" defaultValue={submissions.find((item) => item.ownerUid === user?.uid)?.modelUrl || ""} />
                  <a className="tm-link-button" href="https://teachablemachine.withgoogle.com/train/image" target="_blank" rel="noreferrer">
                    티쳐블머신 열기
                  </a>
                </div>
                <button type="submit">모델 제출</button>
              </form>
            )}
            <SubmissionList submissions={submissions} isTeacher={canManageRoom} onRemove={removeSubmission} />
          </section>

          {canManageRoom && (
            <section className="panel teacher-panel">
              <div className="panel-head">
                <div>
                    <span className="section-kicker">Instant scoring</span>
                  <h2>사진 바로 채점</h2>
                  <p>사진 한 장을 넣으면 제출된 모든 모델을 즉시 채점하고 맞춘 팀 점수를 올립니다.</p>
                </div>
                <span className="badge">{challengePhoto ? "사진 준비" : "사진 없음"}</span>
              </div>
              <label className="drop-zone">
                <input type="file" accept="image/*" onChange={(event) => setScoringPhoto(event.target.files)} />
                <strong>채점할 사진 넣기</strong>
                <span>사진 한 장을 넣고 정답 라벨을 고르세요</span>
              </label>
              {challengePhoto ? (
                <article className="instant-photo-card">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={challengePhoto.url} alt={challengePhoto.name} />
                  <div className="instant-photo-form">
                    <label>
                      <span>사진 이름</span>
                      <input value={challengePhoto.name} onChange={(event) => updateScoringPhoto({ name: event.target.value })} aria-label="사진 이름" />
                    </label>
                    <label>
                      <span>정답</span>
                      <select value={challengePhoto.answer} onChange={(event) => updateScoringPhoto({ answer: event.target.value })} aria-label="정답">
                        {room.labels.map((label) => <option key={label} value={label}>{label}</option>)}
                      </select>
                    </label>
                    <button type="button" onClick={clearScoringPhoto}>사진 바꾸기</button>
                  </div>
                </article>
              ) : (
                <p className="empty">아직 채점할 사진이 없습니다. 사진을 넣으면 바로 점수 라운드를 시작할 수 있어요.</p>
              )}
              <button className="score-button" type="button" onClick={runScoring} disabled={busy || !challengePhoto}>
                {busy ? "채점 중" : "이 사진으로 바로 채점"}
              </button>
            </section>
          )}

          <section className="panel results-panel">
            <div className="panel-head">
              <div>
                <span className="section-kicker">Leaderboard</span>
                <h2>실시간 순위</h2>
                <p>사진을 맞춘 팀은 바로 1점씩 올라갑니다.</p>
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
            <th>맞힌 문제</th>
            <th>최근 판정</th>
            <th>평균 확신도</th>
          </tr>
        </thead>
        <tbody>
          {results.map((result) => (
            <tr key={result.id}>
              <td><span className="rank-badge">{result.rank}</span></td>
              <td>{result.teamName}</td>
              <td><strong>{result.score}점</strong></td>
              <td>{result.correct}/{result.total}</td>
              <td>
                <span className={`judgement-pill ${result.lastCorrect ? "correct" : "wrong"}`}>
                  {result.lastCorrect ? "정답" : "오답"}
                </span>
                <span className="prediction-text">
                  {result.lastAnswer ? `${result.lastAnswer} → ${result.lastPredicted || "실패"}` : "아직 최근 판정 없음"}
                </span>
              </td>
              <td>{Math.round((result.averageConfidence || 0) * 100)}%</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
