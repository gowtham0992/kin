export function appendVoiceDraft(draft, transcript) {
  const result = [draft.trim(), transcript.trim()].filter(Boolean).join(" ");
  if (result.length > 800) throw new RangeError("The combined request is too long. Shorten your draft before trying voice input again.");
  return result;
}

// Recognition is injected so lifecycle races can be tested without a microphone.
export function createVoiceInput({ Recognition, onState, onTranscript, onError,
  schedule = setTimeout, unschedule = clearTimeout }) {
  let current = null, timer = null, phase = "idle";
  const supported = typeof Recognition === "function";
  function finish(session, error, deliver = false) {
    if (current !== session) return;
    current = null; phase = "idle"; unschedule(timer); timer = null;
    try { session.recognition.abort(); } catch { /* Already ended. */ }
    onState("idle");
    if (error) onError(error);
    else if (deliver && session.text.trim()) onTranscript(session.text.trim());
    else if (deliver) onError("No speech was recognized. You can try again or type your message.");
  }
  return {
    supported,
    get active() { return current !== null; },
    start() {
      if (!supported || current) return;
      let recognition;
      try { recognition = new Recognition(); }
      catch { onError("Voice input is unavailable. Please type your message."); return; }
      const session = { recognition, text: "" };
      current = session; phase = "listening";
      recognition.lang = "en-US"; recognition.continuous = false;
      recognition.interimResults = false; recognition.maxAlternatives = 1;
      recognition.onresult = event => {
        if (current !== session) return;
        // Rebuild from the complete result list; repeated events cannot duplicate words.
        const text = Array.from(event.results).filter(result => result.isFinal)
          .map(result => result[0]?.transcript ?? "").join(" ").trim();
        if (text.length > 800) { finish(session, "That message is too long. Try a shorter phrase or type it."); return; }
        session.text = text;
      };
      recognition.onerror = event => {
        const message = ["not-allowed", "service-not-allowed"].includes(event.error)
          ? "Microphone access was denied. You can still type your message."
          : event.error === "audio-capture" ? "No microphone is available. Please type your message."
          : "Voice input stopped without a usable result. Please try again or type.";
        finish(session, message);
      };
      recognition.onend = () => finish(session, null, true);
      timer = schedule(() => finish(session, "Voice input timed out. Please try again or type."), 30000);
      onState(phase);
      try { recognition.start(); }
      catch { finish(session, "Voice input could not start. Please type your message."); }
    },
    stop() {
      if (!current || phase !== "listening") return;
      const session = current; phase = "finishing"; onState(phase);
      unschedule(timer);
      timer = schedule(() => finish(session, "Voice input did not finish. Please try again or type."), 3000);
      try { session.recognition.stop(); }
      catch { finish(session, "Voice input could not finish. Please type your message."); }
    },
    cancel() { if (current) finish(current, null); },
  };
}
