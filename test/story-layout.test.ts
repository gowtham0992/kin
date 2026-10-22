import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const html = await readFile(new URL("../simulator/story.html", import.meta.url), "utf8");

describe("local story presentation contract", () => {
  it("identifies the local care demo and its real MCP boundary before the interactive story", () => {
    const opening = html.slice(0, html.indexOf('id="story-app"'));
    expect(opening).toContain("Local care demo · real MCP");
    expect(opening).toContain("Synthetic people, clock and notifications. No live Alexa or SMS connection.");
    expect(opening).not.toMatch(/\bsimulated\b/i);
    expect(opening).not.toContain("<details");
  });

  it("puts deliberate voice input before the editable draft without making voice a submit action", () => {
    const form = html.slice(html.indexOf('id="story-form"'), html.indexOf("</form>"));
    expect(form.indexOf('id="story-voice-start"')).toBeGreaterThan(0);
    expect(form.indexOf('id="story-voice-start"')).toBeLessThan(form.indexOf('id="story-message"'));
    expect(form).toMatch(/id="story-voice-start"[^>]*type="button"[^>]*aria-describedby="story-voice-disclosure story-voice-status"[^>]*disabled/);
    expect(form).toContain('id="story-voice-disclosure"');
    expect(form).toContain('id="story-submit" type="submit"');
  });

  it("keeps synthetic clock controls secondary to the parent and family experience", () => {
    expect(html.indexOf('id="story-advance"')).toBeGreaterThan(html.indexOf('id="story-care-plan"'));
    expect(html).toContain('aria-label="Demonstration clock"');
    expect(html).toContain('id="story-advance" type="button" disabled');
    expect(html).toContain("One explicit time jump. Restart the local server for a fresh story.");
  });

  it("offers direct mobile jumps to unique, focusable parent and family headings", () => {
    const navigation = html.match(/<nav class="story-jump-nav"[^>]*>[\s\S]*?<\/nav>/)?.[0] ?? "";
    expect(navigation).toContain('href="#parent-heading">Parent check-in</a>');
    expect(navigation).toContain('href="#caregiver-heading">Family view</a>');
    for (const id of ["parent-heading", "caregiver-heading"]) {
      expect(html).toContain(`<h2 id="${id}" tabindex="-1">`);
    }
    const ids = Array.from(html.matchAll(/\bid="([^"]+)"/g), match => match[1]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("keeps words separated when the responsive intro line break is hidden", () => {
    expect(html).toContain("Theo catches up.<br /> A small reply");
  });
});
