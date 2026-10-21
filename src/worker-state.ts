export const shutdownState = {
  isStopping: false,
};

export const activeStepHandles = new Map<string, Set<{ cancel: () => Promise<void> }>>();

export async function abortActiveWorkerTask() {
  if (!activeStepHandles.size) {
    return;
  }
  console.log("⚡ Cancelling active step execution handles due to worker shutdown...");
  await Promise.allSettled(
    [...activeStepHandles.values()].flatMap((handles) => [...handles].map((handle) => handle.cancel())),
  );
  activeStepHandles.clear();
}

export async function abortActiveJob(jobId: string | number): Promise<void> {
  const handles = activeStepHandles.get(String(jobId));
  if (!handles) {
    return;
  }
  await Promise.allSettled([...handles].map((handle) => handle.cancel()));
}
