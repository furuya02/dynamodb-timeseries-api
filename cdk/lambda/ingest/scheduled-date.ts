/** 前日（UTC）の日付（yyyy-MM-dd） */
export const yesterday = (now: number): string => new Date(now - 86_400_000).toISOString().slice(0, 10);
