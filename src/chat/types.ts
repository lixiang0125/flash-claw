import type { Skill } from "../skills";

export interface ChatRequest {
  message: string;
  sessionId?: string;
  userId?: string;
  skill?: string;
}

export interface ChatResponse {
  response: string;
  sessionId: string;
  skills?: Skill[];
  autoMatched?: string;
}
