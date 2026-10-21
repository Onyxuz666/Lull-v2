// Recordings live in IndexedDB on the device. Nothing leaves the phone.
import { SR_STORE } from './engine.js';

const DB_NAME = 'lull';
const STORE = 'mantras';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const s = t.objectStore(STORE);
    const out = fn(s);
    t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : out);
    t.onerror = () => reject(t.error);
  });
}

export async function listMantras() {
  const rows = await tx('readonly', (s) => s.getAll());
  return (rows || []).sort((a, b) => a.created - b.created);
}

export function saveMantra(row) {
  return tx('readwrite', (s) => s.put(row));
}

export function deleteMantra(id) {
  return tx('readwrite', (s) => s.delete(id));
}

export function requestPersistence() {
  try {
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
  } catch (e) {
    /* not available */
  }
}

// ---------- PCM helpers ----------

export function toInt16(f32) {
  const out = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    const v = Math.max(-1, Math.min(1, f32[i]));
    out[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
  }
  return out;
}

export function toFloat32(i16) {
  const a = i16 instanceof Int16Array ? i16 : new Int16Array(i16);
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] / 0x8000;
  return out;
}

// Decode any audio blob the browser understands into mono Float32 at SR_STORE.
export async function decodeToMono(arrayBuffer) {
  const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const ctx = new OAC(1, 1, SR_STORE);
  const audio = await new Promise((resolve, reject) => {
    const p = ctx.decodeAudioData(arrayBuffer, resolve, reject);
    if (p && p.then) p.then(resolve, reject);
  });
  const n = audio.length;
  const mono = new Float32Array(n);
  for (let c = 0; c < audio.numberOfChannels; c++) {
    const d = audio.getChannelData(c);
    for (let i = 0; i < n; i++) mono[i] += d[i] / audio.numberOfChannels;
  }
  if (audio.sampleRate === SR_STORE) return mono;
  // Safari may decode at the file rate; resample linearly
  const ratio = audio.sampleRate / SR_STORE;
  const m = Math.floor(n / ratio);
  const out = new Float32Array(m);
  for (let i = 0; i < m; i++) {
    const x = i * ratio;
    const i0 = Math.floor(x);
    const f = x - i0;
    out[i] = mono[i0] * (1 - f) + (mono[i0 + 1] || 0) * f;
  }
  return out;
}

export function resampleTo(f32, fromSr, toSr = SR_STORE) {
  if (fromSr === toSr) return f32;
  const ratio = fromSr / toSr;
  const m = Math.floor(f32.length / ratio);
  const out = new Float32Array(m);
  for (let i = 0; i < m; i++) {
    const x = i * ratio;
    const i0 = Math.floor(x);
    const f = x - i0;
    out[i] = f32[i0] * (1 - f) + (f32[i0 + 1] || 0) * f;
  }
  return out;
}

// Trim silence at both ends, remove DC, normalize, and add short fades.
export function cleanUp(pcm, sr = SR_STORE) {
  let mean = 0;
  for (let i = 0; i < pcm.length; i++) mean += pcm[i];
  mean /= pcm.length || 1;
  const x = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) x[i] = pcm[i] - mean;

  const win = Math.round(sr * 0.02);
  let peak = 0;
  for (let i = 0; i < x.length; i++) peak = Math.max(peak, Math.abs(x[i]));
  if (peak < 1e-4) return null;
  // threshold relative to the loudest part: -36 dB below peak window RMS
  const rms = [];
  for (let i = 0; i < x.length; i += win) {
    let s = 0;
    const e = Math.min(x.length, i + win);
    for (let j = i; j < e; j++) s += x[j] * x[j];
    rms.push(Math.sqrt(s / (e - i)));
  }
  const maxR = Math.max(...rms);
  const thr = maxR * 0.0158;
  let a = rms.findIndex((r) => r > thr);
  let b = rms.length - 1 - [...rms].reverse().findIndex((r) => r > thr);
  if (a < 0) return null;
  const margin = Math.round((0.12 * sr) / win);
  a = Math.max(0, a - margin);
  b = Math.min(rms.length - 1, b + margin);
  const start = a * win;
  const end = Math.min(x.length, (b + 1) * win);
  const y = x.slice(start, end);

  let pk = 0;
  for (let i = 0; i < y.length; i++) pk = Math.max(pk, Math.abs(y[i]));
  const g = 0.89 / (pk || 1);
  const fade = Math.round(sr * 0.015);
  for (let i = 0; i < y.length; i++) {
    let f = 1;
    if (i < fade) f = i / fade;
    else if (i > y.length - fade) f = (y.length - i) / fade;
    y[i] *= g * f;
  }
  return y;
}

export function wavBlob(f32, sr = SR_STORE) {
  const i16 = toInt16(f32);
  const buf = new ArrayBuffer(44 + i16.length * 2);
  const v = new DataView(buf);
  const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF');
  v.setUint32(4, 36 + i16.length * 2, true);
  w(8, 'WAVE');
  w(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sr, true);
  v.setUint32(28, sr * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  w(36, 'data');
  v.setUint32(40, i16.length * 2, true);
  new Int16Array(buf, 44).set(i16);
  return new Blob([buf], { type: 'audio/wav' });
}
