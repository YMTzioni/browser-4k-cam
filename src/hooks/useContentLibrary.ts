import { useCallback, useEffect, useState } from "react";

/**
 * Local content library for the Lecturer workspace.
 * Stores PDFs (as base64) and URLs in localStorage.
 */

export type LibraryPdf = {
  id: string;
  kind: "pdf";
  name: string;
  /** base64-encoded PDF content (data URL prefix stripped). */
  data: string;
  size: number;
  addedAt: number;
};

export type LibraryUrl = {
  id: string;
  kind: "url";
  name: string;
  url: string;
  addedAt: number;
};

export type LibraryItem = LibraryPdf | LibraryUrl;

const STORAGE_KEY = "lecturer.contentLibrary.v1";
const MAX_PDF_BYTES = 15 * 1024 * 1024; // 15MB hard cap to keep localStorage sane

const readStore = (): LibraryItem[] => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as LibraryItem[];
  } catch {
    return [];
  }
};

const writeStore = (items: LibraryItem[]) => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  } catch (err) {
    console.warn("Library write failed", err);
  }
};

const arrayBufferToBase64 = (buf: ArrayBuffer) => {
  let binary = "";
  const bytes = new Uint8Array(buf);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
  }
  return btoa(binary);
};

export const base64ToArrayBuffer = (b64: string): ArrayBuffer => {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
};

export const useContentLibrary = () => {
  const [items, setItems] = useState<LibraryItem[]>([]);

  useEffect(() => {
    setItems(readStore());
  }, []);

  const persist = useCallback((next: LibraryItem[]) => {
    setItems(next);
    writeStore(next);
  }, []);

  const addPdf = useCallback(async (file: File): Promise<LibraryPdf | null> => {
    if (file.size > MAX_PDF_BYTES) {
      throw new Error(`File too large (${(file.size / 1024 / 1024).toFixed(1)}MB). Max 15MB for the library.`);
    }
    const buf = await file.arrayBuffer();
    const item: LibraryPdf = {
      id: crypto.randomUUID(),
      kind: "pdf",
      name: file.name,
      data: arrayBufferToBase64(buf),
      size: file.size,
      addedAt: Date.now(),
    };
    const current = readStore();
    const next = [item, ...current];
    persist(next);
    return item;
  }, [persist]);

  const addUrl = useCallback((name: string, url: string): LibraryUrl => {
    const item: LibraryUrl = {
      id: crypto.randomUUID(),
      kind: "url",
      name: name || url,
      url,
      addedAt: Date.now(),
    };
    const next = [item, ...readStore()];
    persist(next);
    return item;
  }, [persist]);

  const remove = useCallback((id: string) => {
    persist(readStore().filter((i) => i.id !== id));
  }, [persist]);

  return { items, addPdf, addUrl, remove };
};
