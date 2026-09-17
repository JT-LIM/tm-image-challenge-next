import type { EvaluationPhoto, ResultItem } from "./types";

type Prediction = {
  className: string;
  probability: number;
};

type TeachableMachineImageModel = {
  predict(input: HTMLImageElement | HTMLCanvasElement): Promise<Prediction[]>;
  model?: { dispose?: () => void };
  truncatedModel?: { dispose?: () => void };
};

declare global {
  interface Window {
    tmImage?: {
      load(modelUrl: string, metadataUrl: string): Promise<TeachableMachineImageModel>;
    };
  }
}

const tfjsUrl = "https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@1.3.1/dist/tf.min.js";
const tmImageUrl = "https://cdn.jsdelivr.net/npm/@teachablemachine/image@0.8.3/dist/teachablemachine-image.min.js";
const scriptPromises = new Map<string, Promise<void>>();

export function normalizeText(value: string) {
  return value.trim();
}

export function normalizeForCompare(value: string) {
  return normalizeText(value).toLowerCase().replace(/\s+/g, "");
}

export function normalizeRoomCode(value: string) {
  return normalizeText(value).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
}

export function createRoomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let index = 0; index < 6; index += 1) {
    code += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return code;
}

export function normalizeModelUrl(value: string) {
  const raw = normalizeText(value);
  const match = raw.match(/^https:\/\/teachablemachine\.withgoogle\.com\/models\/([\w-]+)\/?$/i);
  if (!match) {
    throw new Error("Teachable Machine 이미지 모델 공유 링크만 사용할 수 있어요.");
  }
  return `https://teachablemachine.withgoogle.com/models/${match[1]}/`;
}

export function parseLabels(value: string) {
  return value
    .split(/,|\n/)
    .map(normalizeText)
    .filter(Boolean)
    .filter((label, index, labels) => labels.findIndex((item) => normalizeForCompare(item) === normalizeForCompare(label)) === index);
}

function loadScript(src: string) {
  if (scriptPromises.has(src)) return scriptPromises.get(src)!;
  const promise = new Promise<void>((resolve, reject) => {
    const existing = Array.from(document.scripts).find((script) => script.src === src);
    if (existing?.dataset.loaded === "true") {
      resolve();
      return;
    }
    const script = existing || document.createElement("script");
    script.src = src;
    script.async = true;
    script.addEventListener("load", () => {
      script.dataset.loaded = "true";
      resolve();
    }, { once: true });
    script.addEventListener("error", () => reject(new Error(`${src} 로드 실패`)), { once: true });
    if (!existing) document.head.append(script);
  });
  scriptPromises.set(src, promise);
  return promise;
}

export async function ensureTeachableMachine() {
  await loadScript(tfjsUrl);
  await loadScript(tmImageUrl);
  if (!window.tmImage) {
    throw new Error("Teachable Machine 이미지 라이브러리를 불러오지 못했어요.");
  }
}

export function disposeModel(model: TeachableMachineImageModel) {
  const pieces = new Set([model.model, model.truncatedModel]);
  pieces.forEach((piece) => piece?.dispose?.());
}

export async function imageElementForPhoto(photo: EvaluationPhoto) {
  const image = new Image();
  image.decoding = "async";
  image.src = photo.url;

  try {
    if (typeof image.decode === "function") {
      await image.decode();
      return image;
    }
  } catch {
    // Fall back to the load event below. Some browsers reject decode() for
    // object URLs even when the image can still be rendered.
  }

  await new Promise<void>((resolve, reject) => {
    if (image.complete && image.naturalWidth > 0) {
      resolve();
      return;
    }
    image.addEventListener("load", () => resolve(), { once: true });
    image.addEventListener("error", () => reject(new Error("이미지를 읽을 수 없습니다. JPG 또는 PNG 파일로 다시 저장해서 넣어주세요.")), { once: true });
  });

  if (!image.naturalWidth || !image.naturalHeight) {
    throw new Error("이미지를 읽을 수 없습니다. JPG 또는 PNG 파일로 다시 저장해서 넣어주세요.");
  }

  return image;
}

export async function scoreModel(modelUrl: string, photos: EvaluationPhoto[]) {
  await ensureTeachableMachine();
  const model = await window.tmImage!.load(`${modelUrl}model.json`, `${modelUrl}metadata.json`);

  try {
    const items: ResultItem[] = [];
    for (const photo of photos) {
      const image = await imageElementForPhoto(photo);
      const predictions = await model.predict(image);
      const winner = predictions.slice().sort((a, b) => b.probability - a.probability)[0];
      const predicted = winner?.className || "";
      const confidence = winner?.probability || 0;
      items.push({
        photoName: photo.name,
        answer: photo.answer,
        predicted,
        confidence,
        correct: normalizeForCompare(predicted) === normalizeForCompare(photo.answer),
      });
    }
    return items;
  } finally {
    disposeModel(model);
  }
}
