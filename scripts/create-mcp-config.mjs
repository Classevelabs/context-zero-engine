import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const outDir = path.join(repoRoot, '.contextzero', 'mcp');
const envPath = path.join(repoRoot, '.env');
const bridgePath = path.join(repoRoot, 'dist', 'mcp-bridge', 'index.js');

function parseEnvFile(filePath) {
    if (!fs.existsSync(filePath)) return {};
    const parsed = {};
    const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);

    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
        if (!match) continue;

        let value = match[2].trim();
        if (
            (value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))
        ) {
            value = value.slice(1, -1);
        }
        parsed[match[1]] = value;
    }

    return parsed;
}

function pickEnv(source) {
    if (fs.existsSync(envPath)) {
        return {
            CONTEXTZERO_ENV_FILE: envPath,
        };
    }

    const keys = [
        'CONTEXTZERO_ENV_FILE',
        'DB_HOST',
        'DB_PORT',
        'DB_NAME',
        'DB_USER',
        'DB_PASSWORD',
        'DB_SSL_MODE',
        'DB_SSL_CA',
        'NODE_ENV',
        'LOG_LEVEL',
        'SCG_ALLOWED_BASE_PATHS',
        'SCG_MCP_AUTH_ENABLED',
        'SCG_MCP_SECRET',
        'SCG_MAX_FILES_PER_REPO',
        'SCG_MAX_FILE_SIZE_BYTES',
        'SCG_INGEST_WORKERS',
        'SCG_PYTHON_TIMEOUT_MS',
        'PYTHON_BIN',
    ];

    const env = {};
    for (const key of keys) {
        if (typeof source[key] === 'string' && source[key].length > 0) {
            env[key] = source[key];
        }
    }

    env.NODE_ENV ??= 'development';
    env.LOG_LEVEL ??= 'info';
    env.SCG_ALLOWED_BASE_PATHS ??= repoRoot;
    env.SCG_MAX_FILES_PER_REPO ??= '20000';
    env.SCG_MAX_FILE_SIZE_BYTES ??= '1048576';
    env.SCG_INGEST_WORKERS ??= '4';
    env.SCG_PYTHON_TIMEOUT_MS ??= '30000';
    return env;
}

function writeJson(fileName, value) {
    const filePath = path.join(outDir, fileName);
    fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    return filePath;
}

function tomlString(value) {
    return JSON.stringify(value);
}

function writeCodexToml(server) {
    const envEntries = Object.entries(server.env)
        .map(([key, value]) => `${key} = ${tomlString(value)}`)
        .join(', ');
    const content = [
        '[mcp_servers.contextzero]',
        `command = ${tomlString(server.command)}`,
        `args = [${server.args.map(tomlString).join(', ')}]`,
        `env = { ${envEntries} }`,
        '',
    ].join('\n');

    const filePath = path.join(outDir, 'codex-config.toml');
    fs.writeFileSync(filePath, content, 'utf8');
    return filePath;
}

fs.mkdirSync(outDir, { recursive: true });

const fileEnv = parseEnvFile(envPath);
const effectiveEnv = { ...fileEnv, ...process.env };
const server = {
    command: process.execPath,
    args: [bridgePath],
    env: pickEnv(effectiveEnv),
};

const claudeConfig = {
    mcpServers: {
        contextzero: server,
    },
};

const genericConfig = {
    name: 'contextzero',
    transport: 'stdio',
    server,
};

const files = [
    writeJson('claude-desktop.json', claudeConfig),
    writeJson('generic-mcp.json', genericConfig),
    writeCodexToml(server),
];

console.log('Generated MCP config snippets:');
for (const filePath of files) {
    console.log(`- ${filePath}`);
}

if (!fs.existsSync(bridgePath)) {
    console.log('');
    console.log('Warning: dist/mcp-bridge/index.js does not exist yet. Run npm run build before using these configs.');
}
