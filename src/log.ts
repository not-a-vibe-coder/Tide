const debugOn = process.env.LOG_LEVEL === "debug";
const stamp = () => new Date().toISOString();

export const log = {
  info: (...a: unknown[]) => console.log(stamp(), "INFO", ...a),
  warn: (...a: unknown[]) => console.warn(stamp(), "WARN", ...a),
  error: (...a: unknown[]) => console.error(stamp(), "ERROR", ...a),
  debug: (...a: unknown[]) => {
    if (debugOn) console.log(stamp(), "DEBUG", ...a);
  },
};
