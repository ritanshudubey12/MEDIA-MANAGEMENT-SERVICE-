import { env } from '../config/env.js';

// Snowflake-style BIGINT generator: 41 bits ms timestamp | 10 bits worker | 12 bits sequence (fits signed int64).
const EPOCH = 1735689600000n; // 2025-01-01T00:00:00Z
let lastMs = -1n;
let seq = 0n;

export function nextId(): string {
  let now = BigInt(Date.now());
  if (now < lastMs) now = lastMs; // clock went backwards; keep monotonic
  if (now === lastMs) {
    seq = (seq + 1n) & 0xfffn;
    if (seq === 0n) {
      while (now <= lastMs) now = BigInt(Date.now());
    }
  } else {
    seq = 0n;
  }
  lastMs = now;
  return (((now - EPOCH) << 22n) | (BigInt(env.WORKER_ID) << 12n) | seq).toString();
}
