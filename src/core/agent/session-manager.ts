import type { AgentSession, AgentMessage } from "./types";

export class SessionManager {
  private sessions = new Map<string, AgentSession>();

  create(sessionId: string): AgentSession {
    const session: AgentSession = {
      id: sessionId,
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.sessions.set(sessionId, session);
    return session;
  }

  get(sessionId: string): AgentSession | undefined {
    return this.sessions.get(sessionId);
  }

  getOrCreate(sessionId: string): AgentSession {
    if (!this.sessions.has(sessionId)) {
      return this.create(sessionId);
    }
    return this.sessions.get(sessionId)!;
  }

  addMessage(sessionId: string, message: AgentMessage): void {
    const session = this.getOrCreate(sessionId);
    session.messages.push(message);
    session.updatedAt = Date.now();
  }

  getMessages(sessionId: string): AgentMessage[] {
    return this.sessions.get(sessionId)?.messages || [];
  }

  clear(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  list(): AgentSession[] {
    return Array.from(this.sessions.values());
  }
}
