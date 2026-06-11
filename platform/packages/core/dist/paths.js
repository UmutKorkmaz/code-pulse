"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.expandHome = expandHome;
exports.defaultDataDir = defaultDataDir;
exports.ensureDir = ensureDir;
exports.readTextFileIfExists = readTextFileIfExists;
exports.writeTextFile = writeTextFile;
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
function expandHome(inputPath) {
    if (inputPath === '~') {
        return os.homedir();
    }
    if (inputPath.startsWith('~/') || inputPath.startsWith('~\\')) {
        return path.join(os.homedir(), inputPath.slice(2));
    }
    return inputPath;
}
function defaultDataDir() {
    return path.join(os.homedir(), '.codepulse');
}
function ensureDir(dirPath) {
    fs.mkdirSync(dirPath, { recursive: true });
}
function readTextFileIfExists(filePath) {
    try {
        return fs.readFileSync(filePath, 'utf8');
    }
    catch (error) {
        if (error.code === 'ENOENT') {
            return undefined;
        }
        throw error;
    }
}
function writeTextFile(filePath, contents) {
    ensureDir(path.dirname(filePath));
    fs.writeFileSync(filePath, contents, 'utf8');
}
//# sourceMappingURL=paths.js.map