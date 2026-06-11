export interface ParsedArgs {
    command?: string;
    subcommand?: string;
    json: boolean;
    help: boolean;
}
export declare function parseArgs(argv: string[]): ParsedArgs;
export declare function printHelp(): void;
export declare function runCli(argv: string[]): Promise<number>;
//# sourceMappingURL=cli.d.ts.map