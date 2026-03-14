/**
 * Convert cron expression to human-readable Chinese.
 */
export function cronToHumanReadable(cron: string): string {
  if (cron === "once") return "一次性";

  const parts = cron.split(" ");
  if (parts.length !== 5) return cron;

  const [minute, hour, _day, _month, week] = parts;

  // */N * * * * -> 每N分钟
  if (minute?.startsWith("*/") && hour === "*") {
    return `每 ${minute.slice(2)} 分钟`;
  }

  // 0 */N * * * -> 每N小时
  if (minute === "0" && hour?.startsWith("*/")) {
    return `每 ${hour.slice(2)} 小时`;
  }

  // M H * * * -> 每天 HH:MM
  if (minute?.match(/^\d+$/) && hour?.match(/^\d+$/) && week === "*") {
    return `每天 ${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;
  }

  // M H * * DOW -> 每周X HH:MM
  if (minute?.match(/^\d+$/) && hour?.match(/^\d+$/) && week?.match(/^\d$/)) {
    const dayNames = ["日", "一", "二", "三", "四", "五", "六"];
    const dayName = dayNames[parseInt(week, 10)] ?? week;
    return `每周${dayName} ${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;
  }

  return cron;
}
