/** 从游标起循环取 count 个元素（不足回绕），返回原顺序切片。 */
export function pickRotation<T>(items: T[], cursor: number, count: number): T[] {
  if (items.length === 0 || count <= 0) return [];
  const picked: T[] = [];
  const start = ((cursor % items.length) + items.length) % items.length;
  for (let index = 0; index < Math.min(count, items.length); index += 1) {
    picked.push(items[(start + index) % items.length]);
  }
  return picked;
}
