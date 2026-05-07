import { DateTime } from "luxon";

/** Polymarket 15m crypto up/down slug uses Unix seconds of ET interval start */
export function slugForCurrent15m(base: string, now: Date = new Date()): string {
  const et = DateTime.fromJSDate(now).setZone("America/New_York");
  const flooredMin = Math.floor(et.minute / 15) * 15;
  const start = et.set({ minute: flooredMin, second: 0, millisecond: 0 });
  const unix = Math.floor(start.toSeconds());
  return `${base.toLowerCase()}-updown-15m-${unix}`;
}
