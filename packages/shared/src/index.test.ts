import { describe, expect, it } from "vitest";
import { UserSchema, MessageSchema } from "./index";

describe("index barrel re-export", () => {
  it("re-exports schemas from ./schemas.js", () => {
    expect(
      UserSchema.safeParse({ id: "u1", username: "alice", displayName: "Alice" }).success,
    ).toBe(true);
    expect(typeof MessageSchema).toBe("object");
  });
});
