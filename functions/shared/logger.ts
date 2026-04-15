type LogLevel = 'info' | 'warn' | 'error';

interface LogEntry {
  level: LogLevel;
  message: string;
  functionName: string;
  timestamp: string;
  [key: string]: unknown;
}

export function log(
  level: LogLevel,
  functionName: string,
  message: string,
  extra?: Record<string, unknown>,
) {
  const entry: LogEntry = {
    level,
    message,
    functionName,
    timestamp: new Date().toISOString(),
    ...extra,
  };
  console.log(JSON.stringify(entry));
}
