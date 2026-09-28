// Shared by the HTTP allowlist and deployment packager. Never copy the demo directory wholesale.
export const familyAssets = [
  "home.html", "home.css", "conversation.css",
  "kin.webmanifest", "kin-icon.png", "kin-phone-icon.png", "kin-logo.png", "kin-sw.js", "install.js", "push-controls.js",
  "invite.html", "invite.js", "invite.css", "invite-client.js", "browser-auth.js", "styles.css",
  "workspace.js", "workspace-client.js", "workspace.css", "care-client.js", "completion-undo.js", "voice-input.js", "roster-editor.js", "duty-rotation.js", "plan-pause.js", "how-kin-works.html", "mcp-client.js",
] as const;
