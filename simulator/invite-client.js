// No persisted credentials or codes. The authenticated host supplies its request function.
export function createInvitationClient({ request = fetch } = {}) {
  let inFlight = null;
  let generation = 0;
  async function read(response, revision) {
    if (revision !== generation) throw Object.assign(new Error("Session changed"), { stale: true });
    if (!response.ok) throw Object.assign(new Error("Invitation request failed"), { status: response.status });
    const result = await response.json();
    if (revision !== generation) throw Object.assign(new Error("Session changed"), { stale: true });
    return result;
  }
  return {
    async options() {
      const revision = generation;
      return read(await request("/api/invitations/options", {
        cache: "no-store", headers: { accept: "application/json" }, signal: AbortSignal.timeout(8000),
      }), revision);
    },
    issue({ memberId, email, role }) {
      if (inFlight) return inFlight;
      const revision = generation;
      inFlight = Promise.resolve().then(async () => {
        const result = await read(await request("/api/invitations", {
          method: "POST", cache: "no-store", headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({ memberId, email, role }), signal: AbortSignal.timeout(10000),
        }), revision);
        if (!/^[A-Za-z0-9_-]{43}$/.test(result.code) || result.memberId !== memberId || result.role !== role ||
            !Number.isSafeInteger(result.expiresAt) || result.expiresAt <= 0) throw new Error("Invalid invitation receipt");
        return result;
      }).finally(() => { if (revision === generation) inFlight = null; });
      return inFlight;
    },
    reset() { generation += 1; inFlight = null; },
  };
}

export function invitationError(status, writing = false) {
  if (status === 401) return "Sign-in is required. Reconnect to your family workspace and try again.";
  if (status === 403) return "Only a designated family organizer can create invitations. Your access may have changed.";
  if (status === 404) return "Invitations are not enabled in this environment. No invitation was created.";
  if (status === 409) return "Check that this person has completed account setup and that the roster member is not linked to another account. Existing access cannot be replaced here.";
  if (status === 400) return "Check the member, email address, and permission selection, then try again.";
  return writing
    ? "Kin could not confirm the result. A code may have been created. Creating another will replace the earlier code; nothing will be sent automatically."
    : "Kin could not load invitation options. Check your connection and try again.";
}
