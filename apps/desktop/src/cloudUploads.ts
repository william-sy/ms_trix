import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { backend, isLive } from "./backend";

// Uploads to Files, kept here rather than in the Files view: they carry on, and show again,
// when you go to another view and come back. One upload at a time, file after file.

export interface CloudUpload {
  account: string;
  folder: string;
  /** The file going up now (counting from 1) of how many; its name and how far it is (0–1). */
  index: number;
  count: number;
  name: string;
  fraction: number;
}

export type CloudUploadResult = { account: string; folder: string; count: number } | { account: string; error: string };

let current: CloudUpload | null = null;
let result: CloudUploadResult | null = null;
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((l) => l());

// The host's progress for the file going up (at most once per percent).
if (isLive) {
  void listen<{ name: string; sent: number; total: number }>("trix://cloud-upload", (e) => {
    if (!current || e.payload.name !== current.name) return;
    current = { ...current, fraction: e.payload.total ? e.payload.sent / e.payload.total : 1 };
    changed();
  });
}

const fileName = (path: string) => path.split(/[\\/]/).pop() || path;

/** Uploads `paths` into `folder` on `account`; ignored while another upload runs. */
export async function startCloudUpload(account: string, folder: string, paths: string[]) {
  if (current || !paths.length) return;
  result = null;
  try {
    for (const [i, path] of paths.entries()) {
      current = { account, folder, index: i + 1, count: paths.length, name: fileName(path), fraction: 0 };
      changed();
      await backend.cloudUploadPaths(account, folder, [path]);
    }
    result = { account, folder, count: paths.length };
  } catch (e) {
    result = { account, error: String(e) };
  } finally {
    current = null;
    changed();
  }
}

/** The upload going on (or null) and how the last one ended, until `takeCloudUploadResult`. */
export function useCloudUpload() {
  const [, render] = useState(0);
  useEffect(() => {
    const update = () => render((n) => n + 1);
    listeners.add(update);
    return () => void listeners.delete(update);
  }, []);
  return { upload: current, result };
}

export function takeCloudUploadResult(): CloudUploadResult | null {
  const taken = result;
  result = null;
  return taken;
}
