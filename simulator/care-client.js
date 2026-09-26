// The server owns care state. These helpers only coordinate in-flight requests.
export function createSnapshotReader({ fetchSnapshot, onSnapshot, onError }) {
  let revision = 0;
  return {
    invalidate() { revision += 1; },
    async read() {
      const requestRevision = ++revision;
      try {
        const snapshot = await fetchSnapshot();
        if (requestRevision === revision) onSnapshot(snapshot);
      } catch {
        if (requestRevision === revision) onError();
      }
    },
  };
}

// Uncertainty belongs to the exact in-memory request, never its serialized body.
// A gate/auth/validation denial on retry cannot disprove an earlier commit.
export function createWriteRecovery() {
  const uncertain = new WeakSet();
  return (request, error, definitive) => {
    if (error.stale) return false;
    // These callers' reviewed conflicts are receipt-aware. A matching saved
    // result is returned before a stale-review conflict can be produced.
    if (uncertain.has(request) && !(definitive && error.status === 409)) {
      error.outcomeUnknown = true;
      error.definitiveRejection = false;
      return false;
    }
    if (definitive) return true;
    uncertain.add(request);
    return false;
  };
}

export function createConfirmationSender({ send, newRequestId = () => crypto.randomUUID() }) {
  let pending = null;
  let inFlight = null;
  const rejectedWrite = createWriteRecovery();
  const attempt = () => {
    if (inFlight) return inFlight;
    if (!pending) return Promise.reject(new Error("No pending confirmation"));
    const request = { ...pending };
    inFlight = Promise.resolve().then(() => send(request)).then(result => {
      pending = null;
      return result;
    }).catch(error => {
      if (rejectedWrite(pending, error, error?.definitiveRejection === true)) pending = null;
      throw error;
    }).finally(() => { inFlight = null; });
    return inFlight;
  };
  return {
    get pending() { return pending ? { ...pending } : null; },
    confirm(input) {
      if (pending && ["taskId", "response", "actor"].some(key => pending[key] !== input[key])) {
        return Promise.reject(new Error("Resolve the pending confirmation first"));
      }
      pending ??= { ...input, requestId: newRequestId() };
      return attempt();
    },
    retry: attempt,
  };
}
