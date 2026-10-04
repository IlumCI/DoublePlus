/**
 * "Now" as the chain sees it. Ages, countdowns, deadlines and the launch
 * window are all about block timestamps, so they must not follow the device
 * clock: a phone an hour behind showed old coins as seconds old and capped
 * buys the chain allows. The board poll feeds the latest block timestamp in;
 * small drift (block time lag) is ignored.
 */
let offset = 0;
const DRIFT_IGNORED_SECS = 30;

/** Seconds since the epoch, on the chain's clock. */
export const chainNowSecs = (): number => Math.floor(Date.now() / 1000) + offset;

/** Calibrate from a fresh block's timestamp. */
export function syncChainClock(blockTimestampSecs: number, localNowMs = Date.now()): void {
  const d = blockTimestampSecs - Math.floor(localNowMs / 1000);
  offset = Math.abs(d) > DRIFT_IGNORED_SECS ? d : 0;
}
