import fs from 'node:fs';

interface E2EClockState {
  nowIso?: unknown;
}

const RealDate = Date;

function readControlledNowMs(): number | undefined {
  const clockFile = process.env.INDUSTRY_E2E_CLOCK_FILE;
  if (!clockFile || !fs.existsSync(clockFile)) return undefined;

  try {
    const parsed = JSON.parse(
      fs.readFileSync(clockFile, 'utf-8')
    ) as E2EClockState;
    if (typeof parsed.nowIso !== 'string') return undefined;
    const timestamp = RealDate.parse(parsed.nowIso);
    return Number.isNaN(timestamp) ? undefined : timestamp;
  } catch {
    return undefined;
  }
}

if (process.env.INDUSTRY_E2E_CLOCK_FILE) {
  const DateWithControlledNow = function (this: Date, ...args: unknown[]) {
    if (!new.target) {
      return new RealDate(readControlledNowMs() ?? RealDate.now()).toString();
    }

    const dateArgs =
      args.length === 0 ? [readControlledNowMs() ?? RealDate.now()] : args;
    return Reflect.construct(RealDate, dateArgs, new.target);
  };

  DateWithControlledNow.prototype = RealDate.prototype;

  const E2EDate = DateWithControlledNow as unknown as DateConstructor;

  Object.defineProperties(E2EDate, {
    now: {
      value: () => readControlledNowMs() ?? RealDate.now(),
    },
    parse: {
      value: RealDate.parse,
    },
    UTC: {
      value: RealDate.UTC,
    },
  });
  Object.setPrototypeOf(E2EDate, RealDate);

  globalThis.Date = E2EDate;
}
