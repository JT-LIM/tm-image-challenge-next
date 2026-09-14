export type ChallengeRoom = {
  code: string;
  title: string;
  labels: string[];
  teacherUid: string;
  createdAt?: unknown;
  updatedAt?: unknown;
};

export type Submission = {
  id: string;
  teamName: string;
  modelUrl: string;
  ownerUid: string;
  createdAt?: unknown;
  updatedAt?: unknown;
};

export type ResultItem = {
  photoName: string;
  answer: string;
  predicted: string;
  confidence: number;
  correct: boolean;
};

export type ChallengeResult = {
  id: string;
  teamName: string;
  modelUrl: string;
  rank: number;
  score: number;
  correct: number;
  total: number;
  averageConfidence: number;
  misses: ResultItem[];
  lastAnswer?: string;
  lastPredicted?: string;
  lastConfidence?: number;
  lastCorrect?: boolean;
  updatedAt?: unknown;
};

export type EvaluationPhoto = {
  id: string;
  file: File;
  name: string;
  url: string;
  answer: string;
};

export type FirebaseStatus =
  | { configured: true }
  | { configured: false; missingKeys: string[] };
