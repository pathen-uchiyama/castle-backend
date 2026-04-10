import { Logtail } from "@logtail/node";

export interface LogEntry {
    timestamp: string;
    level: 'info' | 'warn' | 'error' | 'debug';
    message: string;
}

class InMemoryLogger {
    private logs: LogEntry[] = [];
    private maxLogs = 200;
    private logtail: Logtail | null = null;
    
    // Store original console methods
    private originalConsoleLog = console.log;
    private originalConsoleWarn = console.warn;
    private originalConsoleError = console.error;
    private originalConsoleInfo = console.info;

    constructor() {
        if (process.env.LOGTAIL_SOURCE_TOKEN) {
            this.logtail = new Logtail(process.env.LOGTAIL_SOURCE_TOKEN);
        }
    }

    public init() {
        console.log = (...args) => {
            this.addLog('info', args);
            this.originalConsoleLog.apply(console, args);
        };
        console.info = (...args) => {
            this.addLog('info', args);
            this.originalConsoleInfo.apply(console, args);
        };
        console.warn = (...args) => {
            this.addLog('warn', args);
            this.originalConsoleWarn.apply(console, args);
        };
        console.error = (...args) => {
            this.addLog('error', args);
            this.originalConsoleError.apply(console, args);
        };
    }

    private addLog(level: LogEntry['level'], args: any[]) {
        const message = args.map(arg => {
            if (typeof arg === 'object') {
                try {
                    return arg instanceof Error ? arg.stack || arg.message : JSON.stringify(arg);
                } catch (e) {
                    return '[Circular Object]';
                }
            }
            return String(arg);
        }).join(' ');

        this.logs.push({
            timestamp: new Date().toISOString(),
            level,
            message
        });

        // BetterStack (Logtail) Streaming
        if (this.logtail) {
            if (level === 'error') {
                this.logtail.error(message);
            } else if (level === 'warn') {
                this.logtail.warn(message);
            }
            // Skipping info/debug to save free-tier quota unless explicitly requested
        }

        // Maintain ring buffer limit
        if (this.logs.length > this.maxLogs) {
            this.logs.shift();
        }
    }

    public getLogs(): LogEntry[] {
        return [...this.logs];
    }
}

export const logger = new InMemoryLogger();
