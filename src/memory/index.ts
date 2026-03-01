import path from "path";
import fs from "fs";

const USER_FILE = "USER.md";
const MEMORY_FILE = "MEMORY.md";
const SOUL_FILE = "SOUL.md";

/**
 * 读取 USER.md 内容
 */
export function readUser(): string {
  const filePath = path.join(process.cwd(), USER_FILE);
  if (!fs.existsSync(filePath)) {
    const template = `# 用户信息

此文件用于存储用户的个人信息和偏好。

## 基础信息

- **名字**: 
- **邮箱**: 
- **公司**: 
- **职位**: 

## 个人简介

在这里添加用户的个人简介...

## 偏好设置

- **沟通风格**: 
- **技术偏好**: 
- **其他偏好**: 

## 重要笔记

记录用户的重要信息、偏好和习惯...
`;
    fs.writeFileSync(filePath, template, "utf-8");
    return template;
  }
  return fs.readFileSync(filePath, "utf-8");
}

/**
 * 更新 USER.md
 */
export function updateUser(content: string): void {
  const filePath = path.join(process.cwd(), USER_FILE);
  fs.writeFileSync(filePath, content, "utf-8");
}

/**
 * 读取 SOUL.md 内容
 */
export function readSoul(): string {
  const filePath = path.join(process.cwd(), SOUL_FILE);
  if (!fs.existsSync(filePath)) {
    const template = `# AI 人格定义

此文件定义 AI 的核心人格、价值观和行为准则。

## 身份

- **名字**: Flash Claw
- **角色**: AI 助手

## 核心价值观

- 保持简洁、直接的沟通风格
- 尊重用户隐私，不泄露敏感信息
- 主动帮助用户解决问题

## 行为准则

- 用中文回复用户
- 语气友好、自然
- 不知道的问题如实告知用户
- 避免过度机械化的回复

## 偏好

- 简洁明了，不过度冗长
`;
    fs.writeFileSync(filePath, template, "utf-8");
    return template;
  }
  return fs.readFileSync(filePath, "utf-8");
}

/**
 * 读取 MEMORY.md 内容
 */
export function readMemory(): string {
  const filePath = path.join(process.cwd(), MEMORY_FILE);
  if (!fs.existsSync(filePath)) {
    const template = `# 长期记忆

此文件用于存储用户的长期记忆和重要事件。
`;
    fs.writeFileSync(filePath, template, "utf-8");
    return template;
  }
  return fs.readFileSync(filePath, "utf-8");
}

/**
 * 更新 MEMORY.md
 */
export function updateMemory(content: string): void {
  const filePath = path.join(process.cwd(), MEMORY_FILE);
  fs.writeFileSync(filePath, content, "utf-8");
}

/**
 * 判断内容是否包含用户信息（需要更新 USER.md）
 */
function isUserInfo(message: string): boolean {
  const keywords = [
    "我叫", "我是", "我的名字", "我喜欢", "我不喜欢", "我爱",
    "我讨厌", "我怕", "我过敏", "我忌口", "我喜欢", "我想要",
    "我的公司", "我的工作", "我是做", "我在", "居住",
    "生日", "年龄", "星座", "血型",
  ];
  const lower = message.toLowerCase();
  return keywords.some(k => lower.includes(k));
}

/**
 * 判断内容是否包含重要记忆（需要更新 MEMORY.md）
 */
function isMemoryWorthy(message: string): boolean {
  const keywords = [
    "记住", "记得", "不要忘记", "提醒我", "很重要", "必须",
    "千万", "一定要", "别忘了", "下次", "以后",
  ];
  const lower = message.toLowerCase();
  return keywords.some(k => lower.includes(k));
}

/**
 * 提取需要记忆的内容类型
 */
export function extractInfoToRemember(message: string): { type: "user" | "memory"; content: string } | null {
  if (isUserInfo(message)) {
    return { type: "user", content: message };
  }
  if (isMemoryWorthy(message)) {
    return { type: "memory", content: message };
  }
  return null;
}
