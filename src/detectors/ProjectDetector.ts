import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export interface ProjectInfo {
    name: string;
    path: string;
    type: string;
    framework?: string;
    language?: string;
    version?: string;
    description?: string;
}

export interface ProjectMetrics {
    totalFiles: number;
    codeFiles: number;
    configFiles: number;
    testFiles: number;
    dependencies: number;
    estimatedSize: 'small' | 'medium' | 'large' | 'enterprise';
}

export class ProjectDetector {
    private currentProject: ProjectInfo | null = null;
    private projectCache: Map<string, ProjectInfo> = new Map();

    constructor() {}

    public getCurrentProject(document?: vscode.TextDocument): string {
        return this.getCurrentProjectInfo(document)?.name || 'unknown';
    }

    public getCurrentProjectInfo(document?: vscode.TextDocument): ProjectInfo | null {
        const projectInfo = this.resolveProjectInfo(document);
        this.currentProject = projectInfo;
        return projectInfo;
    }

    public getProjectPath(document?: vscode.TextDocument): string | null {
        return this.getCurrentProjectInfo(document)?.path || null;
    }

    public getProjectType(document?: vscode.TextDocument): string {
        return this.getCurrentProjectInfo(document)?.type || 'unknown';
    }

    public async getProjectMetrics(document?: vscode.TextDocument): Promise<ProjectMetrics | null> {
        const project = this.getCurrentProjectInfo(document);

        if (!project) {
            return null;
        }

        return this.calculateProjectMetrics(project.path);
    }

    public async analyzeProject(projectPath: string): Promise<ProjectInfo> {
        // Check cache first
        if (this.projectCache.has(projectPath)) {
            return this.projectCache.get(projectPath)!;
        }

        const projectInfo = await this.detectProjectInfo(projectPath);
        this.projectCache.set(projectPath, projectInfo);
        
        return projectInfo;
    }

    public clearCache(): void {
        this.projectCache.clear();
        this.currentProject = null;
    }

    private resolveProjectInfo(document?: vscode.TextDocument): ProjectInfo | null {
        const workspaceFolder = this.getWorkspaceFolder(document);

        if (!workspaceFolder) {
            return null;
        }

        const projectPath = workspaceFolder.uri.fsPath;
        const cachedProject = this.projectCache.get(projectPath);

        if (cachedProject) {
            return cachedProject;
        }

        const fallbackProject: ProjectInfo = {
            name: workspaceFolder.name,
            path: projectPath,
            type: 'unknown'
        };

        this.projectCache.set(projectPath, fallbackProject);

        void this.detectProjectInfo(projectPath).then(projectInfo => {
            this.projectCache.set(projectPath, projectInfo);
            if (this.currentProject?.path === projectPath || this.currentProject === null) {
                this.currentProject = projectInfo;
            }
        }).catch(error => {
            console.error('Failed to detect project info:', error);
        });

        return fallbackProject;
    }

    private getWorkspaceFolder(document?: vscode.TextDocument): vscode.WorkspaceFolder | null {
        if (document) {
            const matchingWorkspace = vscode.workspace.getWorkspaceFolder(document.uri);
            if (matchingWorkspace) {
                return matchingWorkspace;
            }
        }

        const activeEditor = vscode.window.activeTextEditor;
        if (activeEditor) {
            const activeWorkspace = vscode.workspace.getWorkspaceFolder(activeEditor.document.uri);
            if (activeWorkspace) {
                return activeWorkspace;
            }
        }

        return vscode.workspace.workspaceFolders?.[0] ?? null;
    }

    private async detectProjectInfo(projectPath: string): Promise<ProjectInfo> {
        const projectName = path.basename(projectPath);
        let projectType = 'unknown';
        let framework: string | undefined;
        let language: string | undefined;
        let version: string | undefined;
        let description: string | undefined;

        try {
            // Check for various project files and determine type
            const projectFiles = await this.getProjectFiles(projectPath);
            
            // JavaScript/TypeScript projects
            if (projectFiles.includes('package.json')) {
                const packageInfo = await this.readPackageJson(projectPath);
                if (packageInfo) {
                    projectType = this.determineJSProjectType(packageInfo, projectFiles);
                    language = this.determineJSLanguage(projectFiles);
                    framework = this.determineJSFramework(packageInfo);
                    version = packageInfo.version;
                    description = packageInfo.description;
                }
            }
            // Python projects
            else if (projectFiles.some(f => ['requirements.txt', 'setup.py', 'pyproject.toml', 'Pipfile'].includes(f))) {
                projectType = 'python';
                language = 'python';
                framework = await this.determinePythonFramework(projectPath, projectFiles);
                
                if (projectFiles.includes('pyproject.toml')) {
                    const pyprojectInfo = await this.readPyprojectToml(projectPath);
                    version = pyprojectInfo?.version;
                    description = pyprojectInfo?.description;
                }
            }
            // Java projects
            else if (projectFiles.some(f => ['pom.xml', 'build.gradle', 'gradle.properties'].includes(f))) {
                projectType = 'java';
                language = 'java';
                
                if (projectFiles.includes('pom.xml')) {
                    framework = 'maven';
                    const pomInfo = await this.readPomXml(projectPath);
                    version = pomInfo?.version;
                    description = pomInfo?.description;
                } else if (projectFiles.includes('build.gradle')) {
                    framework = 'gradle';
                }
            }
            // .NET projects
            else if (projectFiles.some(f => f.endsWith('.csproj') || f.endsWith('.sln') || f.endsWith('.fsproj') || f.endsWith('.vbproj'))) {
                projectType = 'dotnet';
                language = this.determineDotNetLanguage(projectFiles);
                framework = '.NET';
            }
            // Go projects
            else if (projectFiles.includes('go.mod')) {
                projectType = 'go';
                language = 'go';
                const goModInfo = await this.readGoMod(projectPath);
                version = goModInfo?.version;
            }
            // Rust projects
            else if (projectFiles.includes('Cargo.toml')) {
                projectType = 'rust';
                language = 'rust';
                framework = 'cargo';
                const cargoInfo = await this.readCargoToml(projectPath);
                version = cargoInfo?.version;
                description = cargoInfo?.description;
            }
            // Ruby projects
            else if (projectFiles.includes('Gemfile')) {
                projectType = 'ruby';
                language = 'ruby';
                framework = await this.determineRubyFramework(projectPath, projectFiles);
            }
            // PHP projects
            else if (projectFiles.includes('composer.json')) {
                projectType = 'php';
                language = 'php';
                const composerInfo = await this.readComposerJson(projectPath);
                framework = this.determinePHPFramework(composerInfo);
                version = composerInfo?.version;
                description = composerInfo?.description;
            }
            // Mobile projects
            else if (projectFiles.includes('pubspec.yaml')) {
                projectType = 'flutter';
                language = 'dart';
                framework = 'flutter';
                const pubspecInfo = await this.readPubspecYaml(projectPath);
                version = pubspecInfo?.version;
                description = pubspecInfo?.description;
            }
            else if (projectFiles.some(f => ['ios', 'android'].some(dir => f.includes(dir)) && f.endsWith('.xcodeproj'))) {
                projectType = 'ios';
                language = 'swift';
                framework = 'xcode';
            }
            // Docker projects
            else if (projectFiles.includes('Dockerfile') || projectFiles.includes('docker-compose.yml')) {
                projectType = 'docker';
                framework = 'docker';
            }
            // Generic project types based on dominant file extensions
            else {
                const dominantLanguage = await this.detectDominantLanguage(projectPath);
                if (dominantLanguage) {
                    projectType = dominantLanguage;
                    language = dominantLanguage;
                }
            }

        } catch (error) {
            console.error('Error detecting project info:', error);
        }

        return {
            name: projectName,
            path: projectPath,
            type: projectType,
            framework,
            language,
            version,
            description
        };
    }

    private async getProjectFiles(projectPath: string): Promise<string[]> {
        try {
            return await fs.promises.readdir(projectPath);
        } catch (error) {
            return [];
        }
    }

    private async readPackageJson(projectPath: string): Promise<any> {
        try {
            const packagePath = path.join(projectPath, 'package.json');
            const content = await fs.promises.readFile(packagePath, 'utf8');
            return JSON.parse(content);
        } catch (error) {
            return null;
        }
    }

    private determineJSProjectType(packageJson: any, projectFiles: string[]): string {
        if (packageJson.dependencies || packageJson.devDependencies) {
            const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };
            
            if (deps.react || deps['@types/react']) return 'react';
            if (deps.vue || deps['@vue/cli']) return 'vue';
            if (deps.angular || deps['@angular/core']) return 'angular';
            if (deps.next) return 'nextjs';
            if (deps.nuxt) return 'nuxtjs';
            if (deps.express) return 'express';
            if (deps.electron) return 'electron';
            if (deps.svelte) return 'svelte';
        }
        
        if (projectFiles.includes('angular.json')) return 'angular';
        if (projectFiles.includes('nuxt.config.js') || projectFiles.includes('nuxt.config.ts')) return 'nuxtjs';
        if (projectFiles.includes('next.config.js') || projectFiles.includes('next.config.ts')) return 'nextjs';
        
        return 'javascript';
    }

    private determineJSLanguage(projectFiles: string[]): string {
        const hasTS = projectFiles.some(f => f.endsWith('.ts') || f.endsWith('.tsx') || f === 'tsconfig.json');
        return hasTS ? 'typescript' : 'javascript';
    }

    private determineJSFramework(packageJson: any): string | undefined {
        if (!packageJson.dependencies && !packageJson.devDependencies) return undefined;
        
        const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };
        
        if (deps.react) return 'React';
        if (deps.vue) return 'Vue.js';
        if (deps.angular) return 'Angular';
        if (deps.express) return 'Express.js';
        if (deps.electron) return 'Electron';
        if (deps.svelte) return 'Svelte';
        if (deps.next) return 'Next.js';
        if (deps.nuxt) return 'Nuxt.js';
        
        return undefined;
    }

    private async determinePythonFramework(projectPath: string, projectFiles: string[]): Promise<string | undefined> {
        // Check requirements.txt for common frameworks
        if (projectFiles.includes('requirements.txt')) {
            try {
                const reqPath = path.join(projectPath, 'requirements.txt');
                const content = await fs.promises.readFile(reqPath, 'utf8');
                
                if (content.includes('django')) return 'Django';
                if (content.includes('flask')) return 'Flask';
                if (content.includes('fastapi')) return 'FastAPI';
                if (content.includes('tornado')) return 'Tornado';
                if (content.includes('pyramid')) return 'Pyramid';
            } catch (error) {
                // Ignore file read errors
            }
        }
        
        // Check for framework-specific files
        if (projectFiles.includes('manage.py')) return 'Django';
        if (projectFiles.includes('app.py') || projectFiles.includes('main.py')) {
            // Could be Flask or FastAPI, but we can't be certain
            return 'Python Web';
        }
        
        return undefined;
    }

    private async readPomXml(projectPath: string): Promise<{ version?: string; description?: string } | null> {
        try {
            const pomPath = path.join(projectPath, 'pom.xml');
            const content = await fs.promises.readFile(pomPath, 'utf8');
            
            const versionMatch = content.match(/<version>(.*?)<\/version>/);
            const descriptionMatch = content.match(/<description>(.*?)<\/description>/);
            
            return {
                version: versionMatch?.[1],
                description: descriptionMatch?.[1]
            };
        } catch (error) {
            return null;
        }
    }

    private determineDotNetLanguage(projectFiles: string[]): string {
        if (projectFiles.some(f => f.endsWith('.cs') || f.endsWith('.csproj'))) return 'csharp';
        if (projectFiles.some(f => f.endsWith('.fs') || f.endsWith('.fsproj'))) return 'fsharp';
        if (projectFiles.some(f => f.endsWith('.vb') || f.endsWith('.vbproj'))) return 'vb.net';
        return 'csharp'; // Default to C#
    }

    private async readGoMod(projectPath: string): Promise<{ version?: string } | null> {
        try {
            const goModPath = path.join(projectPath, 'go.mod');
            const content = await fs.promises.readFile(goModPath, 'utf8');
            
            const versionMatch = content.match(/go\s+(\d+\.\d+)/);
            
            return {
                version: versionMatch?.[1]
            };
        } catch (error) {
            return null;
        }
    }

    private async readCargoToml(projectPath: string): Promise<{ version?: string; description?: string } | null> {
        try {
            const cargoPath = path.join(projectPath, 'Cargo.toml');
            const content = await fs.promises.readFile(cargoPath, 'utf8');
            
            const versionMatch = content.match(/version\s*=\s*"(.*?)"/);
            const descriptionMatch = content.match(/description\s*=\s*"(.*?)"/);
            
            return {
                version: versionMatch?.[1],
                description: descriptionMatch?.[1]
            };
        } catch (error) {
            return null;
        }
    }

    private async determineRubyFramework(projectPath: string, projectFiles: string[]): Promise<string | undefined> {
        // Check for Rails
        if (projectFiles.includes('config.ru') || projectFiles.includes('Rakefile')) {
            return 'Ruby on Rails';
        }
        
        // Check Gemfile for other frameworks
        try {
            const gemfilePath = path.join(projectPath, 'Gemfile');
            const content = await fs.promises.readFile(gemfilePath, 'utf8');
            
            if (content.includes('rails')) return 'Ruby on Rails';
            if (content.includes('sinatra')) return 'Sinatra';
            if (content.includes('padrino')) return 'Padrino';
        } catch (error) {
            // Ignore file read errors
        }
        
        return undefined;
    }

    private async readComposerJson(projectPath: string): Promise<any> {
        try {
            const composerPath = path.join(projectPath, 'composer.json');
            const content = await fs.promises.readFile(composerPath, 'utf8');
            return JSON.parse(content);
        } catch (error) {
            return null;
        }
    }

    private determinePHPFramework(composerJson: any): string | undefined {
        if (!composerJson || !composerJson.require) return undefined;
        
        const deps = composerJson.require;
        
        if (deps['laravel/framework']) return 'Laravel';
        if (deps['symfony/framework-bundle']) return 'Symfony';
        if (deps['cakephp/cakephp']) return 'CakePHP';
        if (deps['codeigniter4/framework']) return 'CodeIgniter';
        if (deps['slim/slim']) return 'Slim';
        
        return undefined;
    }

    private async readPubspecYaml(projectPath: string): Promise<{ version?: string; description?: string } | null> {
        try {
            const pubspecPath = path.join(projectPath, 'pubspec.yaml');
            const content = await fs.promises.readFile(pubspecPath, 'utf8');
            
            const versionMatch = content.match(/version:\s*(.+)/);
            const descriptionMatch = content.match(/description:\s*(.+)/);
            
            return {
                version: versionMatch?.[1]?.trim(),
                description: descriptionMatch?.[1]?.trim()
            };
        } catch (error) {
            return null;
        }
    }

    private async readPyprojectToml(projectPath: string): Promise<{ version?: string; description?: string } | null> {
        try {
            const pyprojectPath = path.join(projectPath, 'pyproject.toml');
            const content = await fs.promises.readFile(pyprojectPath, 'utf8');
            
            const versionMatch = content.match(/version\s*=\s*"(.*?)"/);
            const descriptionMatch = content.match(/description\s*=\s*"(.*?)"/);
            
            return {
                version: versionMatch?.[1],
                description: descriptionMatch?.[1]
            };
        } catch (error) {
            return null;
        }
    }

    private async detectDominantLanguage(projectPath: string): Promise<string | null> {
        const languageExtensions: { [key: string]: string[] } = {
            'python': ['.py'],
            'java': ['.java'],
            'csharp': ['.cs'],
            'cpp': ['.cpp', '.cxx', '.cc'],
            'c': ['.c'],
            'go': ['.go'],
            'rust': ['.rs'],
            'php': ['.php'],
            'ruby': ['.rb'],
            'swift': ['.swift'],
            'kotlin': ['.kt']
        };
        
        const extensionCounts: { [key: string]: number } = {};
        
        try {
            const files = await this.getFileRecursively(projectPath, 100); // Limit to 100 files for performance
            
            files.forEach(file => {
                const ext = path.extname(file);
                extensionCounts[ext] = (extensionCounts[ext] || 0) + 1;
            });
            
            // Find the most common language
            let maxCount = 0;
            let dominantLanguage: string | null = null;
            
            Object.entries(languageExtensions).forEach(([language, extensions]) => {
                const count = extensions.reduce((sum, ext) => sum + (extensionCounts[ext] || 0), 0);
                if (count > maxCount) {
                    maxCount = count;
                    dominantLanguage = language;
                }
            });
            
            return maxCount >= 3 ? dominantLanguage : null; // Require at least 3 files
            
        } catch (error) {
            return null;
        }
    }

    private async getFileRecursively(dir: string, maxFiles: number): Promise<string[]> {
        const files: string[] = [];
        const stack = [dir];
        
        while (stack.length > 0 && files.length < maxFiles) {
            const currentDir = stack.pop()!;
            
            try {
                const items = await fs.promises.readdir(currentDir, { withFileTypes: true });
                
                for (const item of items) {
                    if (files.length >= maxFiles) break;
                    
                    const fullPath = path.join(currentDir, item.name);
                    
                    if (item.isDirectory()) {
                        // Skip common directories that don't contain source code
                        if (!['node_modules', '.git', 'dist', 'build', '__pycache__', '.vscode'].includes(item.name)) {
                            stack.push(fullPath);
                        }
                    } else if (item.isFile()) {
                        files.push(fullPath);
                    }
                }
            } catch (error) {
                // Ignore directories we can't read
            }
        }
        
        return files;
    }

    private async calculateProjectMetrics(projectPath: string): Promise<ProjectMetrics> {
        try {
            const files = await this.getFileRecursively(projectPath, 1000);
            
            let codeFiles = 0;
            let configFiles = 0;
            let testFiles = 0;
            
            const codeExtensions = ['.js', '.ts', '.jsx', '.tsx', '.py', '.java', '.cs', '.cpp', '.c', '.go', '.rs', '.php', '.rb', '.swift', '.kt'];
            const configExtensions = ['.json', '.yml', '.yaml', '.xml', '.toml', '.ini', '.cfg', '.conf'];
            const testPatterns = ['/test/', '/tests/', '/spec/', '__test__', '.test.', '.spec.'];
            
            files.forEach(file => {
                const ext = path.extname(file).toLowerCase();
                const fileName = path.basename(file).toLowerCase();
                const filePath = file.toLowerCase();
                
                // Check if it's a test file
                if (testPatterns.some(pattern => filePath.includes(pattern) || fileName.includes(pattern))) {
                    testFiles++;
                } else if (codeExtensions.includes(ext)) {
                    codeFiles++;
                } else if (configExtensions.includes(ext)) {
                    configFiles++;
                }
            });
            
            // Estimate dependencies (simplified)
            let dependencies = 0;
            const packageJsonPath = path.join(projectPath, 'package.json');
            try {
                const packageJson = JSON.parse(await fs.promises.readFile(packageJsonPath, 'utf8'));
                dependencies = Object.keys(packageJson.dependencies || {}).length + Object.keys(packageJson.devDependencies || {}).length;
            } catch (error) {
                // Ignore if package.json doesn't exist
            }
            
            // Estimate project size
            let estimatedSize: 'small' | 'medium' | 'large' | 'enterprise';
            if (codeFiles < 20) {
                estimatedSize = 'small';
            } else if (codeFiles < 100) {
                estimatedSize = 'medium';
            } else if (codeFiles < 500) {
                estimatedSize = 'large';
            } else {
                estimatedSize = 'enterprise';
            }
            
            return {
                totalFiles: files.length,
                codeFiles,
                configFiles,
                testFiles,
                dependencies,
                estimatedSize
            };
            
        } catch (error) {
            return {
                totalFiles: 0,
                codeFiles: 0,
                configFiles: 0,
                testFiles: 0,
                dependencies: 0,
                estimatedSize: 'small'
            };
        }
    }
}
