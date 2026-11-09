const starting = new Map<string, Promise<unknown>>();

/** Serialize claims through worker registration. Waiting for a build happens outside this slot. */
export async function withBuildSlot<T>(hackathonId: string, claim: () => Promise<T>) {
  const previous = starting.get(hackathonId);
  const pending = (previous?.catch(() => undefined) ?? Promise.resolve()).then(claim);
  starting.set(hackathonId, pending);
  try {
    return await pending;
  } finally {
    if (starting.get(hackathonId) === pending) starting.delete(hackathonId);
  }
}
