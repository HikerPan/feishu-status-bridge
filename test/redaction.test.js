import assert from "node:assert/strict";
import test from "node:test";

import { redactSensitive } from "../index.js";

test("redacts common API keys and access tokens", () => {
  const input = [
    "OPENAI_API_KEY=sk-proj-abc123456789",
    "GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz",
    "gitlab=glpat-abc123456789",
    "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload",
    "--api-key super-secret-value"
  ].join(" ");

  const output = redactSensitive(input);

  assert.match(output, /OPENAI_API_KEY=\[redacted\]/);
  assert.match(output, /GITHUB_TOKEN=\[redacted\]/);
  assert.match(output, /glpat-\[redacted\]/);
  assert.match(output, /Bearer \[redacted\]/);
  assert.match(output, /--api-key \[redacted\]/);
  assert.doesNotMatch(output, /sk-proj-abc123456789/);
  assert.doesNotMatch(output, /ghp_abcdefghijklmnopqrstuvwxyz/);
  assert.doesNotMatch(output, /super-secret-value/);
});

test("redacts emails and phone numbers from card text", () => {
  const output = redactSensitive(
    "Contact jane.parent@example.com or +1 (415) 555-0188 for details."
  );

  assert.match(output, /\[email\]/);
  assert.match(output, /\[phone\]/);
  assert.doesNotMatch(output, /jane\.parent@example\.com/);
  assert.doesNotMatch(output, /415\) 555-0188/);
});

test("redacts sensitive URL query parameters while keeping safe parameters", () => {
  const output = redactSensitive(
    "GET https://example.test/callback?token=abc123456&safe=ok&password=hunter2#done"
  );

  assert.match(output, /token=\[redacted\]/);
  assert.match(output, /password=\[redacted\]/);
  assert.match(output, /safe=ok/);
  assert.doesNotMatch(output, /abc123456/);
  assert.doesNotMatch(output, /hunter2/);
});
