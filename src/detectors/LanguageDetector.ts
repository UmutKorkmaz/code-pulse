import * as vscode from 'vscode';
import * as path from 'path';

export interface LanguageInfo {
    id: string;
    name: string;
    category: 'programming' | 'markup' | 'data' | 'config' | 'other';
    extensions: string[];
    isProductive: boolean;
}

export class LanguageDetector {
    private languageMap: Map<string, LanguageInfo> = new Map();

    constructor() {
        this.initializeLanguageMap();
    }

    public detectLanguage(document: vscode.TextDocument): string {
        // First try to get language from VS Code's detection
        if (document.languageId && document.languageId !== 'plaintext') {
            return this.normalizeLanguageId(document.languageId);
        }

        // Fallback to file extension detection
        const fileName = document.fileName;
        if (fileName) {
            const extension = path.extname(fileName).toLowerCase();
            const detectedLanguage = this.detectLanguageByExtension(extension);
            if (detectedLanguage) {
                return detectedLanguage;
            }
        }

        // Final fallback to file name patterns
        if (fileName) {
            const detectedLanguage = this.detectLanguageByFileName(fileName);
            if (detectedLanguage) {
                return detectedLanguage;
            }
        }

        return 'plaintext';
    }

    public getLanguageInfo(languageId: string): LanguageInfo | null {
        return this.languageMap.get(languageId.toLowerCase()) || null;
    }

    public isProductiveLanguage(languageId: string): boolean {
        const info = this.getLanguageInfo(languageId);
        return info?.isProductive || false;
    }

    public getLanguageCategory(languageId: string): string {
        const info = this.getLanguageInfo(languageId);
        return info?.category || 'other';
    }

    public getLanguageName(languageId: string): string {
        const info = this.getLanguageInfo(languageId);
        return info?.name || languageId;
    }

    public getAllSupportedLanguages(): LanguageInfo[] {
        return Array.from(this.languageMap.values()).sort((a, b) => a.name.localeCompare(b.name));
    }

    public getLanguagesByCategory(category: string): LanguageInfo[] {
        return Array.from(this.languageMap.values())
            .filter(lang => lang.category === category)
            .sort((a, b) => a.name.localeCompare(b.name));
    }

    public getProductiveLanguages(): LanguageInfo[] {
        return Array.from(this.languageMap.values())
            .filter(lang => lang.isProductive)
            .sort((a, b) => a.name.localeCompare(b.name));
    }

    private normalizeLanguageId(languageId: string): string {
        // Normalize common VS Code language IDs
        const normalizations: { [key: string]: string } = {
            'javascript': 'javascript',
            'typescript': 'typescript',
            'typescriptreact': 'typescript',
            'javascriptreact': 'javascript',
            'python': 'python',
            'java': 'java',
            'csharp': 'csharp',
            'cpp': 'cpp',
            'c': 'c',
            'go': 'go',
            'rust': 'rust',
            'php': 'php',
            'ruby': 'ruby',
            'swift': 'swift',
            'kotlin': 'kotlin',
            'scala': 'scala',
            'html': 'html',
            'css': 'css',
            'scss': 'scss',
            'sass': 'sass',
            'json': 'json',
            'xml': 'xml',
            'yaml': 'yaml',
            'markdown': 'markdown',
            'sql': 'sql',
            'shellscript': 'bash',
            'powershell': 'powershell',
            'dockerfile': 'dockerfile',
            'makefile': 'makefile'
        };

        return normalizations[languageId.toLowerCase()] || languageId.toLowerCase();
    }

    private detectLanguageByExtension(extension: string): string | null {
        const extensionMap: { [key: string]: string } = {
            '.js': 'javascript',
            '.jsx': 'javascript',
            '.ts': 'typescript',
            '.tsx': 'typescript',
            '.py': 'python',
            '.java': 'java',
            '.cs': 'csharp',
            '.cpp': 'cpp',
            '.cxx': 'cpp',
            '.cc': 'cpp',
            '.c': 'c',
            '.h': 'c',
            '.hpp': 'cpp',
            '.go': 'go',
            '.rs': 'rust',
            '.php': 'php',
            '.rb': 'ruby',
            '.swift': 'swift',
            '.kt': 'kotlin',
            '.scala': 'scala',
            '.html': 'html',
            '.htm': 'html',
            '.css': 'css',
            '.scss': 'scss',
            '.sass': 'sass',
            '.less': 'less',
            '.json': 'json',
            '.xml': 'xml',
            '.yml': 'yaml',
            '.yaml': 'yaml',
            '.md': 'markdown',
            '.markdown': 'markdown',
            '.sql': 'sql',
            '.sh': 'bash',
            '.bash': 'bash',
            '.zsh': 'bash',
            '.ps1': 'powershell',
            '.dockerfile': 'dockerfile',
            '.makefile': 'makefile',
            '.mk': 'makefile',
            '.vue': 'vue',
            '.svelte': 'svelte',
            '.dart': 'dart',
            '.r': 'r',
            '.m': 'matlab',
            '.pl': 'perl',
            '.lua': 'lua',
            '.vim': 'vim',
            '.asm': 'assembly',
            '.s': 'assembly'
        };

        return extensionMap[extension] || null;
    }

    private detectLanguageByFileName(fileName: string): string | null {
        const baseName = path.basename(fileName).toLowerCase();

        // Special file name patterns
        const fileNamePatterns: { [key: string]: string } = {
            'dockerfile': 'dockerfile',
            'makefile': 'makefile',
            'rakefile': 'ruby',
            'gemfile': 'ruby',
            'podfile': 'ruby',
            'vagrantfile': 'ruby',
            'package.json': 'json',
            'composer.json': 'json',
            'tsconfig.json': 'json',
            '.gitignore': 'gitignore',
            '.env': 'dotenv',
            '.editorconfig': 'editorconfig'
        };

        return fileNamePatterns[baseName] || null;
    }

    private initializeLanguageMap(): void {
        const languages: LanguageInfo[] = [
            // Programming Languages
            { id: 'javascript', name: 'JavaScript', category: 'programming', extensions: ['.js', '.jsx'], isProductive: true },
            { id: 'typescript', name: 'TypeScript', category: 'programming', extensions: ['.ts', '.tsx'], isProductive: true },
            { id: 'python', name: 'Python', category: 'programming', extensions: ['.py'], isProductive: true },
            { id: 'java', name: 'Java', category: 'programming', extensions: ['.java'], isProductive: true },
            { id: 'csharp', name: 'C#', category: 'programming', extensions: ['.cs'], isProductive: true },
            { id: 'cpp', name: 'C++', category: 'programming', extensions: ['.cpp', '.cxx', '.cc', '.hpp'], isProductive: true },
            { id: 'c', name: 'C', category: 'programming', extensions: ['.c', '.h'], isProductive: true },
            { id: 'go', name: 'Go', category: 'programming', extensions: ['.go'], isProductive: true },
            { id: 'rust', name: 'Rust', category: 'programming', extensions: ['.rs'], isProductive: true },
            { id: 'php', name: 'PHP', category: 'programming', extensions: ['.php'], isProductive: true },
            { id: 'ruby', name: 'Ruby', category: 'programming', extensions: ['.rb'], isProductive: true },
            { id: 'swift', name: 'Swift', category: 'programming', extensions: ['.swift'], isProductive: true },
            { id: 'kotlin', name: 'Kotlin', category: 'programming', extensions: ['.kt'], isProductive: true },
            { id: 'scala', name: 'Scala', category: 'programming', extensions: ['.scala'], isProductive: true },
            { id: 'dart', name: 'Dart', category: 'programming', extensions: ['.dart'], isProductive: true },
            { id: 'r', name: 'R', category: 'programming', extensions: ['.r'], isProductive: true },
            { id: 'matlab', name: 'MATLAB', category: 'programming', extensions: ['.m'], isProductive: true },
            { id: 'perl', name: 'Perl', category: 'programming', extensions: ['.pl'], isProductive: true },
            { id: 'lua', name: 'Lua', category: 'programming', extensions: ['.lua'], isProductive: true },
            { id: 'assembly', name: 'Assembly', category: 'programming', extensions: ['.asm', '.s'], isProductive: true },

            // Web Technologies
            { id: 'html', name: 'HTML', category: 'markup', extensions: ['.html', '.htm'], isProductive: true },
            { id: 'css', name: 'CSS', category: 'markup', extensions: ['.css'], isProductive: true },
            { id: 'scss', name: 'SCSS', category: 'markup', extensions: ['.scss'], isProductive: true },
            { id: 'sass', name: 'Sass', category: 'markup', extensions: ['.sass'], isProductive: true },
            { id: 'less', name: 'Less', category: 'markup', extensions: ['.less'], isProductive: true },
            { id: 'vue', name: 'Vue', category: 'programming', extensions: ['.vue'], isProductive: true },
            { id: 'svelte', name: 'Svelte', category: 'programming', extensions: ['.svelte'], isProductive: true },

            // Data & Configuration
            { id: 'json', name: 'JSON', category: 'data', extensions: ['.json'], isProductive: false },
            { id: 'xml', name: 'XML', category: 'data', extensions: ['.xml'], isProductive: false },
            { id: 'yaml', name: 'YAML', category: 'data', extensions: ['.yml', '.yaml'], isProductive: false },
            { id: 'toml', name: 'TOML', category: 'data', extensions: ['.toml'], isProductive: false },
            { id: 'sql', name: 'SQL', category: 'data', extensions: ['.sql'], isProductive: true },

            // Markup & Documentation
            { id: 'markdown', name: 'Markdown', category: 'markup', extensions: ['.md', '.markdown'], isProductive: false },
            { id: 'rst', name: 'reStructuredText', category: 'markup', extensions: ['.rst'], isProductive: false },
            { id: 'latex', name: 'LaTeX', category: 'markup', extensions: ['.tex'], isProductive: true },

            // Scripts & Configuration
            { id: 'bash', name: 'Bash', category: 'programming', extensions: ['.sh', '.bash', '.zsh'], isProductive: true },
            { id: 'powershell', name: 'PowerShell', category: 'programming', extensions: ['.ps1'], isProductive: true },
            { id: 'batch', name: 'Batch', category: 'programming', extensions: ['.bat', '.cmd'], isProductive: true },
            { id: 'dockerfile', name: 'Dockerfile', category: 'config', extensions: ['.dockerfile'], isProductive: true },
            { id: 'makefile', name: 'Makefile', category: 'config', extensions: ['.makefile', '.mk'], isProductive: true },

            // Specialized
            { id: 'vim', name: 'Vim Script', category: 'config', extensions: ['.vim'], isProductive: false },
            { id: 'gitignore', name: 'Git Ignore', category: 'config', extensions: ['.gitignore'], isProductive: false },
            { id: 'dotenv', name: 'Environment Variables', category: 'config', extensions: ['.env'], isProductive: false },
            { id: 'editorconfig', name: 'EditorConfig', category: 'config', extensions: ['.editorconfig'], isProductive: false },

            // Fallback
            { id: 'plaintext', name: 'Plain Text', category: 'other', extensions: ['.txt'], isProductive: false }
        ];

        languages.forEach(lang => {
            this.languageMap.set(lang.id, lang);
        });
    }
}