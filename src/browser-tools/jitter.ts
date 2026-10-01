/** 全局 jitter 工具：为固定延时加随机偏移，降低等间隔 bot 特征。 */

/**
 * 返回 base + random(0, jitter) 的毫秒数。
 * jitter <= 0 时返回 base 原值（不影响无 jitter 声明的工具）。
 */
export function jitterDelay(baseMs: number, jitterMs?: number): number {
  if (!jitterMs || jitterMs <= 0) return Math.max(0, baseMs);
  return Math.max(0, Math.round(baseMs + Math.random() * jitterMs));
}

/**
 * 返回 base + random(-jitter/2, +jitter/2) 的像素偏移（用于滚动距离）。
 * 允许负向抖动（滚少一点），但总量不为负。
 */
export function jitterOffset(base: number, jitter?: number): number {
  if (!jitter || jitter <= 0) return base;
  return Math.max(50, Math.round(base + (Math.random() - 0.5) * jitter * 2));
}
