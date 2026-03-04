import { decode as msgpackDecode, encode as msgpackEncode } from "@msgpack/msgpack";
import pako from "pako";

const BASE64_CHUNK_RE = /[A-Za-z0-9+/=\r\n]{32,}/g;

export interface SaveTextParts {
  prefix: string;
  payload: string;
  suffix: string;
}

function isBase64Text(value: string): boolean {
  return value.length > 0 && /^[A-Za-z0-9+/=]+$/.test(value);
}

function normalizeBase64(value: string): string {
  return value.replace(/\s+/g, "");
}

export function extractSavePayload(raw: string): SaveTextParts {
  const compact = normalizeBase64(raw.trim());
  if (compact.length >= 32 && isBase64Text(compact)) {
    return { prefix: "", payload: compact, suffix: "" };
  }

  const candidates = Array.from(raw.matchAll(BASE64_CHUNK_RE));
  let best: RegExpMatchArray | null = null;
  let bestLength = 0;

  for (const candidate of candidates) {
    const segment = normalizeBase64(candidate[0]);
    if (!segment || !isBase64Text(segment)) {
      continue;
    }
    if (segment.length > bestLength) {
      best = candidate;
      bestLength = segment.length;
    }
  }

  if (!best || best.index == null) {
    throw new Error("无法在文本中找到可用的存档 base64 载荷。");
  }

  return {
    prefix: raw.slice(0, best.index),
    payload: normalizeBase64(best[0]),
    suffix: raw.slice(best.index + best[0].length),
  };
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

export function decodeSaveText(raw: string): { value: unknown; parts: SaveTextParts } {
  const parts = extractSavePayload(raw);
  const compressed = base64ToBytes(parts.payload);
  const packed = pako.inflate(compressed);
  const value = msgpackDecode(packed);
  return { value, parts };
}

export function encodeSaveText(value: unknown, parts?: SaveTextParts): string {
  const packed = msgpackEncode(value);
  const compressed = pako.deflate(packed, { level: 9 });
  const payload = bytesToBase64(compressed);
  if (!parts) {
    return payload;
  }
  return `${parts.prefix}${payload}${parts.suffix}`;
}
