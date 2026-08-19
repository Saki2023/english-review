"use strict";

const fixedNow = process.env.TEST_FIXED_NOW;
if (fixedNow) {
  const NativeDate = Date;
  const fixedTime = NativeDate.parse(fixedNow);
  if (!Number.isFinite(fixedTime)) throw new Error("TEST_FIXED_NOW must be an ISO date");

  global.Date = class FixedDate extends NativeDate {
    constructor(...args) {
      super(...(args.length ? args : [fixedTime]));
    }

    static now() {
      return fixedTime;
    }
  };
}
