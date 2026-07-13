import { describe, it, expect } from "vitest";

// extractJson is duplicated across agents; test its logic
function extractJson(text: string): string {
  const codeMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  return codeMatch ? codeMatch[1].trim() : text.trim();
}

describe("extractJson", () => {
  it("extracts from code-fenced block", () => {
    const input = '```json\n{"cause": "test"}\n```';
    expect(extractJson(input)).toBe('{"cause": "test"}');
  });

  it("extracts from code block without json label", () => {
    const input = '```\n{"key": "value"}\n```';
    expect(extractJson(input)).toBe('{"key": "value"}');
  });

  it("passes through raw JSON", () => {
    const input = '{"key": "value"}';
    expect(extractJson(input)).toBe('{"key": "value"}');
  });

  it("trims whitespace", () => {
    expect(extractJson('  {"a":1}  ')).toBe('{"a":1}');
  });

  it("handles multiline JSON in fence", () => {
    const input = '```\n{\n  "a": 1,\n  "b": 2\n}\n```';
    expect(extractJson(input)).toBe('{\n  "a": 1,\n  "b": 2\n}');
  });

  it("handles empty string", () => {
    expect(extractJson("")).toBe("");
  });
});
