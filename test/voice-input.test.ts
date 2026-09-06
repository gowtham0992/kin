import { afterEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error Browser-native module is tested directly.
import { createVoiceInput } from "../simulator/voice-input.js";

class Recognition {
  static instances: Recognition[] = [];
  onresult = (_event: unknown) => {};
  onend = () => {};
  onerror = (_event: unknown) => {};
  start = vi.fn(); stop = vi.fn(); abort = vi.fn();
  constructor() { Recognition.instances.push(this); }
  result(text: string, isFinal = true) {
    this.onresult({ results: [Object.assign([{ transcript: text }], { isFinal })] });
  }
}
function setup(RecognitionType: unknown = Recognition) {
  const onTranscript = vi.fn(), onState = vi.fn(), onError = vi.fn();
  return { onTranscript, onState, onError, voice: createVoiceInput({ Recognition: RecognitionType, onTranscript, onState, onError }) };
}
afterEach(() => { Recognition.instances = []; vi.useRealTimers(); });
describe("voice draft lifecycle", () => {
  it("starts only on request and delivers a final transcript once after end", () => {
    const { voice, onTranscript } = setup();
    expect(Recognition.instances).toHaveLength(0);
    voice.start(); voice.start();
    expect(Recognition.instances).toHaveLength(1);
    const recognition = Recognition.instances[0]!;
    recognition.result("water done"); recognition.result("water done");
    expect(onTranscript).not.toHaveBeenCalled();
    recognition.onend(); recognition.onend();
    expect(onTranscript.mock.calls).toEqual([["water done"]]);
  });
  it("discards cancelled audio and ignores stale callbacks after a new capture", () => {
    const { voice, onTranscript } = setup();
    voice.start(); const old = Recognition.instances[0]!;
    old.result("wrong draft"); voice.cancel(); voice.start();
    old.result("late draft"); old.onend();
    expect(onTranscript).not.toHaveBeenCalled();
    const current = Recognition.instances[1]!; current.result("new draft"); current.onend();
    expect(onTranscript.mock.calls).toEqual([["new draft"]]);
  });
  it("keeps typed input usable when unsupported or permission is denied", () => {
    const unsupported = setup(null); unsupported.voice.start();
    expect(unsupported.voice.supported).toBe(false);
    expect(Recognition.instances).toHaveLength(0);
    const { voice, onError, onTranscript } = setup();
    voice.start(); const recognition = Recognition.instances[0]!;
    recognition.onerror({ error: "not-allowed" }); recognition.result("late"); recognition.onend();
    expect(voice.active).toBe(false);
    expect(onError).toHaveBeenCalledWith(expect.stringContaining("denied"));
    expect(onTranscript).not.toHaveBeenCalled();
  });
  it("stops on a bounded deadline even if the browser never emits end", () => {
    vi.useFakeTimers();
    const { voice, onError } = setup(); voice.start(); voice.stop();
    expect(Recognition.instances[0]!.stop).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(3000);
    expect(voice.active).toBe(false);
    expect(Recognition.instances[0]!.abort).toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(expect.stringContaining("did not finish"));
  });
  it("rejects oversized results without silently truncating meaning", () => {
    const { voice, onTranscript, onError } = setup(); voice.start();
    Recognition.instances[0]!.result("x".repeat(801));
    expect(voice.active).toBe(false);
    expect(onTranscript).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(expect.stringContaining("too long"));
  });
  it("does not insert interim or empty results", () => {
    const { voice, onTranscript, onError } = setup(); voice.start();
    const recognition = Recognition.instances[0]!; recognition.result("maybe", false); recognition.onend();
    expect(onTranscript).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(expect.stringContaining("No speech"));
  });
});
