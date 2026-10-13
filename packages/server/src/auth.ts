import { randomBytes, createHash } from "node:crypto";

const tokens = new Map<string, string>(); // token -> userId

export function issueToken(userId: string): string {
  const token = randomBytes(32).toString("hex");
  tokens.set(token, userId);
  return token;
}

export function userIdFromToken(token: string): string | null {
  if (!token) return null;
  const digest = createHash("sha256").update(token).digest("hex");
  for (const [t, id] of tokens) {
    if (createHash("sha256").update(t).digest("hex") === digest) return id;
  }
  return null;
}
