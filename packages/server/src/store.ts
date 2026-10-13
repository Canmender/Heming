import { randomUUID } from "node:crypto";
import type { User, Message } from "@heming/shared";

export interface FriendshipRequest {
  id: string;
  fromId: string;
  toId: string;
  status: "pending" | "accepted";
}

export interface Store {
  createUser(username: string, passwordHash: string, displayName: string): User;
  findUserByUsername(username: string): { user: User; passwordHash: string } | null;
  findUserById(id: string): User | null;
  createFriendRequest(fromId: string, toUsername: string): { id: string; from: User; to: User; status: "pending" };
  acceptFriendRequest(requestId: string, userId: string): { id: string; user: User };
  listFriends(userId: string): { id: string; user: User }[];
  listIncomingRequests(userId: string): { id: string; from: User }[];
  createDirectConversation(aId: string, bId: string): { id: string; type: "direct"; peer: User };
  listConversations(userId: string): { id: string; type: "direct"; peer: User }[];
  isMember(conversationId: string, userId: string): boolean;
  addMessage(
    conversationId: string,
    senderType: "user" | "agent",
    senderId: string,
    payload: { text: string },
    replyTo: string | null,
  ): Message;
  listMessages(conversationId: string, limit?: number): Message[];
}

export function createMemoryStore(): Store {
  const users = new Map<string, { user: User; passwordHash: string }>();
  const usersByName = new Map<string, string>();
  const requests: FriendshipRequest[] = [];
  const conversations = new Map<string, { members: string[] }>();
  const messages = new Map<string, Message[]>();
  const pairToConv = new Map<string, string>();

  const mustUser = (id: string): User => {
    const row = users.get(id);
    if (!row) throw new Error("user not found");
    return row.user;
  };
  const pairKey = (a: string, b: string): string => [a, b].sort().join("|");

  return {
    createUser(username, passwordHash, displayName) {
      if (usersByName.has(username)) throw new Error("username taken");
      const user: User = { id: randomUUID(), username, displayName };
      users.set(user.id, { user, passwordHash });
      usersByName.set(username, user.id);
      return user;
    },
    findUserByUsername(username) {
      const id = usersByName.get(username);
      return id ? users.get(id)! : null;
    },
    findUserById(id) {
      return users.get(id)?.user ?? null;
    },
    createFriendRequest(fromId, toUsername) {
      mustUser(fromId);
      const toId = usersByName.get(toUsername);
      if (!toId) throw new Error("peer not found");
      if (toId === fromId) throw new Error("cannot friend self");
      const existing = requests.find(
        (r) =>
          r.status === "pending" &&
          ((r.fromId === fromId && r.toId === toId) || (r.fromId === toId && r.toId === fromId)),
      );
      if (existing) throw new Error("request already exists");
      const req: FriendshipRequest = { id: randomUUID(), fromId, toId, status: "pending" };
      requests.push(req);
      return { id: req.id, from: mustUser(fromId), to: mustUser(toId), status: "pending" };
    },
    acceptFriendRequest(requestId, userId) {
      const req = requests.find((r) => r.id === requestId);
      if (!req) throw new Error("request not found");
      if (req.toId !== userId) throw new Error("not request recipient");
      req.status = "accepted";
      return { id: req.id, user: mustUser(req.fromId) };
    },
    listFriends(userId) {
      return requests
        .filter((r) => r.status === "accepted" && (r.fromId === userId || r.toId === userId))
        .map((r) => ({ id: r.id, user: mustUser(r.fromId === userId ? r.toId : r.fromId) }));
    },
    listIncomingRequests(userId) {
      return requests
        .filter((r) => r.status === "pending" && r.toId === userId)
        .map((r) => ({ id: r.id, from: mustUser(r.fromId) }));
    },
    createDirectConversation(aId, bId) {
      mustUser(aId);
      mustUser(bId);
      const friends = requests.some(
        (r) => r.status === "accepted" && pairKey(r.fromId, r.toId) === pairKey(aId, bId),
      );
      if (!friends) throw new Error("not friends");
      const key = pairKey(aId, bId);
      const existingId = pairToConv.get(key);
      if (existingId) {
        return { id: existingId, type: "direct", peer: mustUser(bId) };
      }
      const id = randomUUID();
      conversations.set(id, { members: [aId, bId] });
      messages.set(id, []);
      pairToConv.set(key, id);
      return { id, type: "direct", peer: mustUser(bId) };
    },
    listConversations(userId) {
      const out: { id: string; type: "direct"; peer: User }[] = [];
      for (const [id, conv] of conversations) {
        if (!conv.members.includes(userId)) continue;
        const peerId = conv.members.find((m) => m !== userId);
        if (peerId) out.push({ id, type: "direct", peer: mustUser(peerId) });
      }
      return out;
    },
    isMember(conversationId, userId) {
      return conversations.get(conversationId)?.members.includes(userId) ?? false;
    },
    addMessage(conversationId, senderType, senderId, payload, replyTo) {
      if (!conversations.has(conversationId)) throw new Error("conversation not found");
      const msg: Message = {
        id: randomUUID(),
        conversationId,
        senderType,
        senderId,
        payload,
        replyTo,
        createdAt: new Date().toISOString(),
      };
      messages.get(conversationId)!.push(msg);
      return msg;
    },
    listMessages(conversationId, limit) {
      const all = messages.get(conversationId);
      if (!all) throw new Error("conversation not found");
      return limit ? all.slice(-limit) : [...all];
    },
  };
}
