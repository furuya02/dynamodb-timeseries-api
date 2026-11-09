import type { Row } from './types';

/** 行の並び順: 時刻 → キー */
export const compareRows = (a: Row, b: Row): number => a.time - b.time || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
