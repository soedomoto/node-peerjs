const LOG_PREFIX = 'PeerJS: ';

/*
Prints log messages depending on the debug level passed in. Defaults to 0.
0  Prints no logs.
1  Prints only errors.
2  Prints errors and warnings.
3  Prints all logs.
*/
const LogLevel = {
    Disabled: 0,
    Errors: 1,
    Warnings: 2,
    All: 3
}

class Logger {
    _logLevel = LogLevel.Disabled;

    get logLevel() { return this._logLevel; }

    set logLevel(logLevel) { this._logLevel = logLevel; }

    log(...args) {
        if (this._logLevel >= LogLevel.All) {
            this._print(LogLevel.All, ...args);
        }
    }

    warn(...args) {
        if (this._logLevel >= LogLevel.Warnings) {
            this._print(LogLevel.Warnings, ...args);
        }
    }

    error(...args) {
        if (this._logLevel >= LogLevel.Errors) {
            this._print(LogLevel.Errors, ...args);
        }
    }

    setLogFunction(fn) {
        this._print = fn;
    }

    _print(logLevel, ...rest) {
        const copy = [LOG_PREFIX, ...rest];

        for (let i in copy) {
            if (copy[i] instanceof Error) {
                copy[i] = "(" + copy[i].name + ") " + copy[i].message;

            }
        }

        if (logLevel >= LogLevel.All) {
            console.log(...copy);
        } else if (logLevel >= LogLevel.Warnings) {
            console.warn("WARNING", ...copy);
        } else if (logLevel >= LogLevel.Errors) {
            console.error("ERROR", ...copy);
        }
    }
}

exports.LogLevel = LogLevel;
exports.logger = new Logger();