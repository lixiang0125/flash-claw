export { UserProfileService, type UserProfile } from "../memory/user-profile";

import { UserProfileService } from "../memory/user-profile";
import type { DatabaseService } from "../memory/short-term-memory";
import type { Logger } from "../memory/embedding/embedding-service";

let userProfileServiceInstance: UserProfileService | null = null;

export function getUserProfileService(db: DatabaseService, logger: Logger): UserProfileService {
  if (!userProfileServiceInstance) {
    userProfileServiceInstance = new UserProfileService(db, logger);
  }
  return userProfileServiceInstance;
}

export const userProfileStore = {
  get: function(sessionId: string) {
    return userProfileServiceInstance?.get(sessionId) ?? null;
  },
  getOrCreate: function(sessionId: string) {
    return userProfileServiceInstance?.getOrCreate(sessionId) ?? null;
  },
  update: function(sessionId: string, updates: Parameters<NonNullable<typeof userProfileServiceInstance>["update"]>[1]) {
    if (!userProfileServiceInstance) return null;
    return userProfileServiceInstance.update(sessionId, updates);
  },
  appendPreference: function(sessionId: string, key: string, value: string) {
    if (!userProfileServiceInstance) return null;
    return userProfileServiceInstance.appendPreference(sessionId, key, value);
  },
  toMarkdown: function(profile: Parameters<NonNullable<typeof userProfileServiceInstance>["toMarkdown"]>[0]) {
    return userProfileServiceInstance?.toMarkdown(profile) ?? "暂无用户信息";
  },
};
