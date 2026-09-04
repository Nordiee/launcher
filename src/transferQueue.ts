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

export function enqueueTransfer(transfer: QueuedTransfer) {
  publishTransferQueue([...currentTransferQueue, transfer]);
}

export function takeNextTransfer() {
  const [next, ...remaining] = currentTransferQueue;
  publishTransferQueue(remaining);
  return next;
}

export function clearTransferQueue() {
  publishTransferQueue([]);
}

export function removeTransferFromQueue(id: string) {
  publishTransferQueue(currentTransferQueue.filter((transfer) => transfer.id !== id));
}

export function moveTransferInQueue(id: string, direction: -1 | 1) {
  const index = currentTransferQueue.findIndex((transfer) => transfer.id === id);
  const targetIndex = index + direction;
  if (index < 0 || targetIndex < 0 || targetIndex >= currentTransferQueue.length) return;
  const nextQueue = [...currentTransferQueue];
  [nextQueue[index], nextQueue[targetIndex]] = [nextQueue[targetIndex], nextQueue[index]];
  publishTransferQueue(nextQueue);
}

export function listenForTransferQueue(listener: (queue: QueuedTransfer[]) => void) {
  const handleChange = (event: Event) => listener((event as CustomEvent<QueuedTransfer[]>).detail);
  window.addEventListener(transferQueueEvent, handleChange);
  return () => window.removeEventListener(transferQueueEvent, handleChange);
}
