import type { LibraryGame } from "./libraryCache";

export type TransferKind = "install" | "repair" | "update";
export type QueuedTransfer = { id: string; game: LibraryGame; kind: TransferKind };

const transferQueueEvent = "nordiee-transfer-queue-changed";
let currentTransferQueue: QueuedTransfer[] = [];

export function readTransferQueue() {
  return currentTransferQueue;
}

export function publishTransferQueue(nextQueue: QueuedTransfer[]) {
  currentTransferQueue = nextQueue;
  window.dispatchEvent(new CustomEvent<QueuedTransfer[]>(transferQueueEvent, { detail: nextQueue }));
}

export function listenForTransferQueue(listener: (queue: QueuedTransfer[]) => void) {
  const handleChange = (event: Event) => listener((event as CustomEvent<QueuedTransfer[]>).detail);
  window.addEventListener(transferQueueEvent, handleChange);
  return () => window.removeEventListener(transferQueueEvent, handleChange);
}
