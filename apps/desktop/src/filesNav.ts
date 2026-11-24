// "Show in Files": a file from a chat (a Talk file message, a link to your own Nextcloud) opens
// in the Files view at its folder, highlighted. App listens for the event and opens the view.

/** A file to show; `at` tells a new request from the last one. */
export interface FilesReveal { account: string; path: string; at: number }

export const SHOW_IN_FILES = "trix:show-in-files";

/** Opens the Files view at a file's folder with the file highlighted. */
export const showInFiles = (account: string, path: string) =>
  window.dispatchEvent(new CustomEvent(SHOW_IN_FILES, { detail: { account, path } }));
