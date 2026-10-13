// Minimal structured-ish logger: ISO timestamp + level + scope, no deps.
const stamp = () => new Date().toISOString();

const emit = (stream, level, scope) => (msg, ...rest) => {
  const line = `${stamp()} ${level.padEnd(5)} [${scope}] ${msg}`;
  if (rest.length) stream(line, ...rest);
  else stream(line);
};

export const createLogger = (scope) => ({
  info: emit(console.log, 'info', scope),
  warn: emit(console.warn, 'warn', scope),
  error: emit(console.error, 'error', scope),
});
