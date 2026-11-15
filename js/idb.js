// IndexedDB для изображений (аватары и флаги) + подготовка файлов.

const DB_NAME = 'omb.db';
const STORE = 'images';
const DB_VERSION = 1;
const LS_KEY = 'omb.images.v1';

let dbPromise = null;
let fallback = false;
const urlCache = new Map();
let memoryMap = null;

// На file:// IndexedDB может быть запрещён — храним сжатые изображения
// как data URL в localStorage (или в памяти, если недоступно и это).
function readLs() {
  if (memoryMap) return memoryMap;
  try {
    return JSON.parse(localStorage.getItem(LS_KEY) || '{}') || {};
  } catch {
    memoryMap = {};
    return memoryMap;
  }
}

function writeLs(map) {
  if (memoryMap) {
    Object.assign(memoryMap, map);
    return;
  }
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(map));
  } catch (err) {
    console.warn('localStorage для изображений недоступен, храним в памяти.', err);
    memoryMap = map;
  }
}

function switchToFallback(err) {
  if (!fallback) {
    fallback = true;
    console.warn('IndexedDB недоступен — изображения хранятся в localStorage.', err);
  }
}

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function tx(mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, mode);
    const store = transaction.objectStore(STORE);
    const req = fn(store);
    transaction.oncomplete = () => resolve(req?.result);
    transaction.onerror = () => reject(transaction.error);
  });
}

export async function putImage(blob, id = null) {
  const imageId = id || `img_${Math.random().toString(36).slice(2, 9)}${Date.now().toString(36).slice(-4)}`;
  if (fallback) {
    const map = readLs();
    map[imageId] = await blobToDataUrl(blob);
    writeLs(map);
    urlCache.delete(imageId);
    return imageId;
  }
  try {
    await tx('readwrite', (store) => store.put({ id: imageId, blob, ts: Date.now() }));
  } catch (err) {
    switchToFallback(err);
    const map = readLs();
    map[imageId] = await blobToDataUrl(blob);
    writeLs(map);
  }
  urlCache.delete(imageId);
  return imageId;
}

export async function getImage(id) {
  if (!id) return null;
  if (fallback) {
    const dataUrl = readLs()[id];
    return dataUrl ? { id, dataUrl } : null;
  }
  try {
    return await tx('readonly', (store) => store.get(id));
  } catch (err) {
    switchToFallback(err);
    const dataUrl = readLs()[id];
    return dataUrl ? { id, dataUrl } : null;
  }
}

export async function getImageUrl(id) {
  if (!id) return null;
  if (urlCache.has(id)) return urlCache.get(id);
  const record = await getImage(id);
  if (!record) return null;
  const url = record.dataUrl || URL.createObjectURL(record.blob);
  urlCache.set(id, url);
  return url;
}

export async function clearImages() {
  for (const url of urlCache.values()) {
    if (String(url).startsWith('blob:')) URL.revokeObjectURL(url);
  }
  urlCache.clear();
  memoryMap = null;
  try { localStorage.removeItem(LS_KEY); } catch { /* приватный режим */ }
  if (fallback) return;
  try {
    await tx('readwrite', (store) => store.clear());
  } catch (err) {
    console.warn('Не удалось очистить хранилище изображений', err);
  }
}

export async function exportImages() {
  if (fallback) return readLs();
  try {
    const records = await tx('readonly', (store) => store.getAll());
    const result = {};
    for (const record of records || []) {
      result[record.id] = await blobToDataUrl(record.blob);
    }
    return result;
  } catch (err) {
    switchToFallback(err);
    return readLs();
  }
}

export async function importImages(map = {}) {
  for (const [id, dataUrl] of Object.entries(map)) {
    try {
      const blob = await (await fetch(dataUrl)).blob();
      await putImage(blob, id);
    } catch (err) {
      console.warn('Не удалось импортировать изображение', id, err);
    }
  }
}

export function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/**
 * Проверяет и уменьшает изображение перед сохранением.
 * Возвращает Blob (JPEG) или выбрасывает ошибку с текстом для пользователя.
 */
export async function prepareImage(file, maxW = 320, maxH = 320) {
  if (!file) throw new Error('Файл не выбран.');
  if (!/^image\/(png|jpeg|webp)$/.test(file.type)) {
    throw new Error('Допустимы только PNG, JPEG или WebP.');
  }
  if (file.size > 2 * 1024 * 1024) {
    throw new Error('Файл больше 2 МБ. Выберите изображение меньше.');
  }

  const bitmap = await createImageBitmap(file);
  const ratio = Math.min(1, maxW / bitmap.width, maxH / bitmap.height);
  const w = Math.max(1, Math.round(bitmap.width * ratio));
  const h = Math.max(1, Math.round(bitmap.height * ratio));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#d9cdb0'; // подложка под прозрачные PNG
  ctx.fillRect(0, 0, w, h);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();

  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.86));
  if (!blob) throw new Error('Не удалось обработать изображение.');
  return blob;
}
