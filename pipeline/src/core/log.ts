export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  child(prefix: string): Logger;
}

export function createLogger(prefix = '', silent = false): Logger {
  const fmt = (msg: string) => (prefix ? `[${prefix}] ${msg}` : msg);
  return {
    info: (m) => !silent && console.log(fmt(m)),
    warn: (m) => !silent && console.warn(`⚠ ${fmt(m)}`),
    error: (m) => !silent && console.error(`✖ ${fmt(m)}`),
    child: (p) => createLogger(prefix ? `${prefix}:${p}` : p, silent),
  };
}
