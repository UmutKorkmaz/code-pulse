#!/usr/bin/env node

async function main(): Promise<void> {
    const { tryStartSdkServer } = await import('./mcp-sdk.js');

    if (await tryStartSdkServer()) {
        return;
    }

    const { startMinimalServer } = await import('./mcp-minimal.js');
    await startMinimalServer();
}

main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
});