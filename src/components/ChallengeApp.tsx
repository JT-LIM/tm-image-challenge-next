"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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
  writeBatch,
} from "firebase/firestore";
import { onAuthStateChanged, signInAnonymously, type User } from "firebase/auth";
import { firebaseStatus, getFirebaseClient } from "@/lib/firebase";
import type { ChallengeResult, ChallengeRoom, EvaluationPhoto, Submission } from "@/lib/types";
import {
  createRoomCode,
  normalizeModelUrl,
  normalizeText,
  parseLabels,
  scoreModel,
} from "@/lib/tm";

export default function ChallengeApp({ adminMode = false }: { adminMode?: boolean }) {
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [activeCode, setActiveCode] = useState("");
  const [rooms, setRooms] = useState<ChallengeRoom[]>([]);
  const [room, setRoom] = useState<ChallengeRoom | null>(null);
  const [submissions, setSubmissions] = useState<Submission[]>([]);
  const [results, setResults] = useState<ChallengeResult[]>([]);
  const [selectedSubmissionIds, setSelectedSubmissionIds] = useState<string[]>([]);
  const [challengePhoto, setChallengePhoto] = useState<EvaluationPhoto | null>(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const challengePhotoUrlRef = useRef<string | null>(null);

  const firebase = useMemo(() => {
    if (!firebaseStatus.configured) return null;
    return getFirebaseClient();
  }, []);

  const isTeacher = Boolean(user && room && user.uid === room.teacherUid);
  const canManageRoom = adminMode && isTeacher;
  const canSubmitModel = Boolean(room && !adminMode);
  const selectedSubmissions = submissions.filter((submission) => selectedSubmissionIds.includes(submission.id));

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
    if (!firebase) return;
    const unsubRooms = onSnapshot(query(collection(firebase.db, "rooms"), orderBy("createdAt", "desc")), (snapshot) => {
      setRooms(snapshot.docs.map((item) => ({ code: item.id, ...item.data() } as ChallengeRoom)));
    });
    return () => unsubRooms();
  }, [firebase]);

  useEffect(() => {
    if (!firebase || !activeCode) return;
    const roomRef = doc(firebase.db, "rooms", activeCode);
    const unsubRoom = onSnapshot(roomRef, (snapshot) => {
      setRoom(snapshot.exists() ? ({ code: snapshot.id, ...snapshot.data() } as ChallengeRoom) : null);
      if (!snapshot.exists()) setNotice("방을 찾을 수 없어요. 목록에서 다시 선택하세요.");
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
      if (challengePhotoUrlRef.current) URL.revokeObjectURL(challengePhotoUrlRef.current);
    };
  }, []);

  function leaveRoom() {
    setActiveCode("");
    setRoom(null);
    setSubmissions([]);
    setResults([]);
    setSelectedSubmissionIds([]);
    setNotice("");
  }

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
      setNotice("방이 만들어졌어요. 학생들은 목록에서 바로 들어갈 수 있습니다.");
      formElement.reset();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "방 만들기 실패");
    } finally {
      setBusy(false);
    }
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
    await addDoc(collection(firebase.db, "rooms", room.code, "submissions"), {
      teamName,
      modelUrl,
      ownerUid: user.uid,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    event.currentTarget.reset();
    setNotice("모델이 제출됐어요. 같은 조 이름으로 모델을 더 올릴 수 있습니다.");
  }

  async function removeSubmission(submissionId: string) {
    if (!firebase || !room) return;
    const batch = writeBatch(firebase.db);
    batch.delete(doc(firebase.db, "rooms", room.code, "submissions", submissionId));
    if (isTeacher) batch.delete(doc(firebase.db, "rooms", room.code, "results", submissionId));
    setSelectedSubmissionIds((current) => current.filter((id) => id !== submissionId));
    await batch.commit();
  }

  function toggleSubmission(submissionId: string, checked: boolean) {
    setSelectedSubmissionIds((current) => {
      if (checked) return current.includes(submissionId) ? current : [...current, submissionId];
      return current.filter((id) => id !== submissionId);
    });
  }

  function selectAllSubmissions() {
    setSelectedSubmissionIds(submissions.map((submission) => submission.id));
  }

  function clearSelectedSubmissions() {
    setSelectedSubmissionIds([]);
  }

  function setScoringPhoto(files: FileList | null) {
    const file = Array.from(files || []).find((item) => item.type.startsWith("image/"));
    if (!file) return;
    if (!file.type.match(/^image\/(jpeg|png|webp|gif)$/)) {
      setNotice("이 이미지 형식은 브라우저가 읽기 어려울 수 있어요. JPG 또는 PNG로 저장해서 다시 넣어주세요.");
      return;
    }
    if (challengePhotoUrlRef.current) URL.revokeObjectURL(challengePhotoUrlRef.current);
    const url = URL.createObjectURL(file);
    challengePhotoUrlRef.current = url;
    setChallengePhoto({
      id: `${file.name}-${crypto.randomUUID()}`,
      file,
      name: file.name.replace(/\.[^.]+$/, ""),
      url,
      answer: room?.labels[0] || "",
    });
  }

  function updateScoringPhoto(patch: Partial<EvaluationPhoto>) {
    setChallengePhoto((current) => (current ? { ...current, ...patch } : current));
  }

  function clearScoringPhoto() {
    if (challengePhotoUrlRef.current) URL.revokeObjectURL(challengePhotoUrlRef.current);
    challengePhotoUrlRef.current = null;
    setChallengePhoto(null);
  }

  async function runScoring() {
    if (!firebase || !room || !isTeacher) return;
    if (!submissions.length) {
      setNotice("제출된 학생 모델이 없습니다.");
      return;
    }
    if (!selectedSubmissions.length) {
      setNotice("채점할 모델을 하나 이상 선택해주세요.");
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
      for (const submission of selectedSubmissions) {
        const previous = results.find((result) => result.id === submission.id);
        const [item] = await scoreModel(submission.modelUrl, [challengePhoto]);
        const previousTotal = previous?.total || 0;
        const previousCorrect = previous?.correct || 0;
        const total = previousTotal + 1;
        const correct = previousCorrect + (item.correct ? 1 : 0);
        const averageConfidence = ((previous?.averageConfidence || 0) * previousTotal + item.confidence) / total;
        scored.push({
          id: submission.id,
          rank: previous?.rank || 0,
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
      const mergedResults = new Map(results.map((result) => [result.id, result]));
      scored.forEach((result) => mergedResults.set(result.id, result));
      const ranked = Array.from(mergedResults.values()).sort(
        (a, b) => b.score - a.score || b.averageConfidence - a.averageConfidence || a.teamName.localeCompare(b.teamName)
      );
      const batch = writeBatch(firebase.db);
      ranked.forEach((result, index) => {
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
      const message = error instanceof Error ? error.message : "채점 실패";
      setNotice(message.includes("decode") || message.includes("decoded") ? "이미지를 읽을 수 없습니다. JPG 또는 PNG 파일로 다시 저장해서 넣어주세요." : message);
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
          <p className="eyebrow">{adminMode ? "Teacher Admin" : "Deokso Middle School"}</p>
          <h1>{adminMode ? "덕소중학교 AI 이미지 분류 관리자" : "덕소중학교 AI 이미지 분류"}</h1>
          <p className="hero-description">
            {adminMode
              ? "방을 만들고, 제출된 모델 중 원하는 모델을 선택해 사진 정답을 확인합니다."
              : "방을 선택해서 들어가고, 조 이름으로 Teachable Machine 이미지 모델을 여러 개 제출하세요."}
          </p>
          <div className="hero-actions">
            <div className={`status-pill ${authReady ? "ready" : "loading"}`}>
              <span aria-hidden="true" />
              {authReady ? "접속 준비 완료" : "익명 접속 준비 중"}
            </div>
          </div>
        </div>
        <div className="hero-card" aria-label="수업 진행 순서">
          <div className="hero-card-top">
            <span>CLASSROOM AI</span>
            {room ? <strong>{room.code}</strong> : <strong>{rooms.length} ROOMS</strong>}
          </div>
          <div className="hero-steps">
            <span>{adminMode ? "1. 방 만들기" : "1. 방 선택"}</span>
            <span>{adminMode ? "2. 모델 선택" : "2. 모델 여러 개 제출"}</span>
            <span>{adminMode ? "3. 정답 확인" : "3. 순위 확인"}</span>
          </div>
          <div className="hero-score">
            <strong>{results[0]?.score ?? 0}</strong>
            <span>현재 최고점</span>
          </div>
        </div>
      </section>

      {room && (
        <section className="control-band">
          <button className="ghost-button" type="button" onClick={leaveRoom}>방 목록으로</button>
          <div className="room-code">
            <span>현재 방</span>
            <strong>{room.title}</strong>
          </div>
          <div className="room-meta">
            <span>{submissions.length}개 모델 제출</span>
            <span>{results[0]?.total || 0}문제 진행</span>
          </div>
        </section>
      )}

      {notice && <div className="notice">{notice}</div>}

      {!room && (
        <RoomList rooms={rooms} adminMode={adminMode} onEnter={(code) => {
          setActiveCode(code);
          setNotice("");
        }} />
      )}

      {!room && adminMode && (
        <section className="panel create-room">
          <div>
            <span className="section-kicker">Teacher room</span>
            <h2>교사용 방 만들기</h2>
            <p>방을 만들면 학생 화면 방 목록에 바로 나타납니다. 라벨 이름은 학생 모델의 클래스 이름과 같아야 합니다.</p>
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
            <h2>방을 선택해서 입장해요</h2>
            <p>목록에서 수업 방을 누른 뒤 조 이름과 Teachable Machine 모델 링크를 제출합니다.</p>
          </div>
          <div className="student-guide-grid">
            <article>
              <strong>1</strong>
              <span>방 목록에서 내 수업 선택</span>
            </article>
            <article>
              <strong>2</strong>
              <span>조 이름으로 모델 여러 개 제출</span>
            </article>
            <article>
              <strong>3</strong>
              <span>선택 채점 후 순위 확인</span>
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
                <p>{canManageRoom ? "관리자 화면" : "학생 화면"}</p>
              </div>
              <span className="badge">{submissions.length}팀 제출</span>
            </div>
            <div className="label-row">
              {room.labels.map((label) => <span key={label}>{label}</span>)}
            </div>
            {canSubmitModel && (
              <form className="model-form" onSubmit={submitModel}>
                <input name="teamName" placeholder="조 이름 예: 1조" />
                <div className="model-link-row">
                  <input name="modelUrl" placeholder="Teachable Machine 모델 링크" />
                  <a className="tm-link-button" href="https://teachablemachine.withgoogle.com/train/image" target="_blank" rel="noreferrer">
                    티쳐블머신 열기
                  </a>
                </div>
                <button type="submit">모델 제출</button>
              </form>
            )}
            <SubmissionList
              submissions={submissions}
              isTeacher={canManageRoom}
              selectedIds={selectedSubmissionIds}
              onToggle={toggleSubmission}
              onSelectAll={selectAllSubmissions}
              onClearSelected={clearSelectedSubmissions}
              onRemove={removeSubmission}
            />
          </section>

          {canManageRoom && (
            <section className="panel teacher-panel">
              <div className="panel-head">
                <div>
                    <span className="section-kicker">Instant scoring</span>
                  <h2>선택 모델 정답 확인</h2>
                  <p>제출 목록에서 선택한 모델만 사진 한 장으로 판정하고 맞춘 모델의 점수를 올립니다.</p>
                </div>
                <span className="badge">{challengePhoto ? "사진 준비" : "사진 없음"}</span>
              </div>
              <label className="drop-zone">
                <input type="file" accept="image/*" onChange={(event) => setScoringPhoto(event.target.files)} />
                <strong>정답 확인할 사진 넣기</strong>
                <span>사진 한 장과 정답 라벨을 고른 뒤 선택 모델을 확인하세요</span>
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
                <p className="empty">아직 확인할 사진이 없습니다. 사진을 넣고 모델을 선택하면 정답 확인을 시작할 수 있어요.</p>
              )}
              <button className="score-button" type="button" onClick={runScoring} disabled={busy || !challengePhoto || !selectedSubmissions.length}>
                {busy ? "확인 중" : `선택한 ${selectedSubmissions.length}개 모델 정답 확인`}
              </button>
            </section>
          )}

          <section className="panel results-panel">
            <div className="panel-head">
              <div>
                <span className="section-kicker">Leaderboard</span>
                <h2>실시간 순위</h2>
                <p>선택한 모델을 확인하면 맞춘 모델은 바로 1점씩 올라갑니다.</p>
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

function RoomList({ rooms, adminMode, onEnter }: {
  rooms: ChallengeRoom[];
  adminMode: boolean;
  onEnter: (code: string) => void;
}) {
  return (
    <section className="panel room-list-panel">
      <div className="panel-head">
        <div>
          <span className="section-kicker">Rooms</span>
          <h2>{adminMode ? "관리할 방 선택" : "참여할 방 선택"}</h2>
          <p>{adminMode ? "방을 누르면 제출 모델을 확인하고 정답 확인을 할 수 있습니다." : "선생님이 만든 방을 누르면 바로 모델을 제출할 수 있습니다."}</p>
        </div>
        <span className="badge">{rooms.length}개 방</span>
      </div>
      {rooms.length ? (
        <div className="room-card-grid">
          {rooms.map((item) => (
            <button className="room-card" type="button" key={item.code} onClick={() => onEnter(item.code)}>
              <span>{item.code}</span>
              <strong>{item.title}</strong>
              <small>{item.labels.join(" · ")}</small>
            </button>
          ))}
        </div>
      ) : (
        <p className="empty">아직 만들어진 방이 없습니다.</p>
      )}
    </section>
  );
}

function SubmissionList({ submissions, isTeacher, selectedIds, onToggle, onSelectAll, onClearSelected, onRemove }: {
  submissions: Submission[];
  isTeacher: boolean;
  selectedIds: string[];
  onToggle: (submissionId: string, checked: boolean) => void;
  onSelectAll: () => void;
  onClearSelected: () => void;
  onRemove: (submissionId: string) => void;
}) {
  if (!submissions.length) {
    return <p className="empty">아직 제출된 모델이 없습니다.</p>;
  }
  return (
    <div className="submission-list-wrap">
      {isTeacher && (
        <div className="selection-actions">
          <span>{selectedIds.length}개 선택됨</span>
          <button type="button" onClick={onSelectAll}>전체 선택</button>
          <button type="button" onClick={onClearSelected}>선택 해제</button>
        </div>
      )}
      <div className="submission-list">
        {submissions.map((submission) => (
          <article key={submission.id} className={`submission-card ${selectedIds.includes(submission.id) ? "selected" : ""}`}>
            {isTeacher && (
              <label className="select-model-check">
                <input
                  type="checkbox"
                  checked={selectedIds.includes(submission.id)}
                  onChange={(event) => onToggle(submission.id, event.target.checked)}
                />
                <span>선택</span>
              </label>
            )}
            <div>
              <strong>{submission.teamName}</strong>
              <span>{submission.modelUrl}</span>
            </div>
            {isTeacher && <button type="button" onClick={() => onRemove(submission.id)}>삭제</button>}
          </article>
        ))}
      </div>
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
