#!/usr/bin/env node

import {
  createGatewayServiceToken,
  listGatewayServiceTokenAudit,
  listGatewayServiceTokens,
  PostgresGatewayStore,
  publicServiceToken,
  revokeGatewayServiceToken,
  rotateGatewayServiceToken,
  updateGatewayServiceToken,
} from '../src/index.js';

const [command, ...rawArgs] = process.argv.slice(2);
const options = parseOptions(rawArgs);

if (!command || command === 'help' || options.help) {
  printHelp();
  process.exit(command ? 0 : 1);
}

const store = new PostgresGatewayStore({
  connectionString: options.postgresUrl ?? process.env.POSTGRES_URL,
});
const context = {
  operator: options.operator ?? process.env.GATEWAY_OPERATOR_ACTOR ?? 'gateway-token-cli',
};

try {
  const result = await runCommand(command, options, store, context);
  writeOutput(result, options);
} catch (error) {
  if (options.json) {
    console.error(JSON.stringify({ error: error.message }));
  } else {
    console.error(`Error: ${error.message}`);
  }
  process.exitCode = 1;
} finally {
  await store.close();
}

async function runCommand(name, opts, tokenStore, ctx) {
  switch (name) {
    case 'create':
      return createGatewayServiceToken(tokenStore, {
        tokenRef: opts.ref,
        token: opts.token,
        actor: opts.actor,
        scopes: listOption(opts.scope ?? opts.scopes),
        tenantIds: listOption(opts.tenant ?? opts.tenantId ?? opts.tenantIds),
        projectIds: listOption(opts.project ?? opts.projectId ?? opts.projectIds),
        expiresAt: opts.expiresAt,
        metadata: metadataOption(opts),
      }, ctx);
    case 'list':
      return {
        items: await listGatewayServiceTokens(tokenStore, {
          includeRevoked: boolOption(opts.includeRevoked, true),
          limit: integerOption(opts.limit, 100),
        }),
      };
    case 'update':
      return {
        token: await updateGatewayServiceToken(tokenStore, {
          tokenRef: opts.ref,
          actor: opts.actor,
          scopes: hasAny(opts, 'scope', 'scopes') ? listOption(opts.scope ?? opts.scopes) : undefined,
          tenantIds: hasAny(opts, 'tenant', 'tenantId', 'tenantIds')
            ? listOption(opts.tenant ?? opts.tenantId ?? opts.tenantIds)
            : undefined,
          projectIds: hasAny(opts, 'project', 'projectId', 'projectIds')
            ? listOption(opts.project ?? opts.projectId ?? opts.projectIds)
            : undefined,
          expiresAt: hasAny(opts, 'expiresAt') ? opts.expiresAt : undefined,
          metadata: metadataOption(opts),
        }, ctx),
      };
    case 'revoke':
      return {
        token: await revokeGatewayServiceToken(tokenStore, {
          tokenRef: opts.ref,
          reason: opts.reason,
        }, ctx),
      };
    case 'rotate':
      return rotateGatewayServiceToken(tokenStore, {
        tokenRef: opts.ref,
        newTokenRef: opts.newRef ?? opts.newTokenRef,
        token: opts.token,
        actor: opts.actor,
        scopes: hasAny(opts, 'scope', 'scopes') ? listOption(opts.scope ?? opts.scopes) : undefined,
        tenantIds: hasAny(opts, 'tenant', 'tenantId', 'tenantIds')
          ? listOption(opts.tenant ?? opts.tenantId ?? opts.tenantIds)
          : undefined,
        projectIds: hasAny(opts, 'project', 'projectId', 'projectIds')
          ? listOption(opts.project ?? opts.projectId ?? opts.projectIds)
          : undefined,
        expiresAt: hasAny(opts, 'expiresAt') ? opts.expiresAt : undefined,
        metadata: metadataOption(opts),
        revokeOld: boolOption(opts.revokeOld, false),
      }, ctx);
    case 'audit':
      return {
        items: await listGatewayServiceTokenAudit(tokenStore, {
          tokenRef: opts.ref,
          limit: integerOption(opts.limit, 100),
        }),
      };
    case 'show': {
      const token = await tokenStore.getServiceToken(required(opts.ref, '--ref'));
      if (!token) {
        throw new Error(`Service token not found: ${opts.ref}`);
      }
      return { token: publicServiceToken(token) };
    }
    default:
      throw new Error(`Unknown command: ${name}`);
  }
}

function writeOutput(result, opts) {
  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (result.token) {
    printToken(result.token);
  }
  if (result.items) {
    for (const item of result.items) {
      if (item.tokenRef) {
        printToken(item);
      } else {
        console.log(JSON.stringify(item));
      }
    }
  }
  if (result.revoked) {
    console.log('');
    console.log('revokedOld:');
    printToken(result.revoked);
  }
  if (result.tokenValue) {
    console.log('');
    console.log(`tokenValue: ${result.tokenValue}`);
    console.log('Store tokenValue now. It is shown once and is not persisted.');
  }
}

function printToken(token) {
  console.log([
    `tokenRef=${token.tokenRef}`,
    `actor=${token.actor}`,
    `scopes=${token.scopes.join(',') || '-'}`,
    `tenants=${token.tenantIds.join(',') || '-'}`,
    `projects=${token.projectIds.join(',') || '-'}`,
    `expiresAt=${token.expiresAt ?? '-'}`,
    `revokedAt=${token.revokedAt ?? '-'}`,
  ].join(' '));
}

function parseOptions(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith('--')) {
      parsed._ = [...(parsed._ ?? []), arg];
      continue;
    }
    const [rawKey, inlineValue] = arg.slice(2).split(/=(.*)/s, 2);
    const key = camelCase(rawKey);
    const value = inlineValue ?? (
      args[index + 1] && !args[index + 1].startsWith('--')
        ? args[++index]
        : true
    );
    if (parsed[key] === undefined) {
      parsed[key] = value;
    } else if (Array.isArray(parsed[key])) {
      parsed[key].push(value);
    } else {
      parsed[key] = [parsed[key], value];
    }
  }
  return parsed;
}

function listOption(value) {
  if (value === undefined) {
    return [];
  }
  const values = Array.isArray(value) ? value : [value];
  return values
    .flatMap((item) => String(item).split(','))
    .map((item) => item.trim())
    .filter(Boolean);
}

function metadataOption(opts) {
  if (!opts.metadataJson) {
    return {};
  }
  const parsed = JSON.parse(opts.metadataJson);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TypeError('--metadata-json must be a JSON object');
  }
  return parsed;
}

function boolOption(value, fallback) {
  if (value === undefined) {
    return fallback;
  }
  if (value === true) {
    return true;
  }
  return !['0', 'false', 'no'].includes(String(value).toLowerCase());
}

function integerOption(value, fallback) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isInteger(parsed) ? parsed : fallback;
}

function hasAny(object, ...keys) {
  return keys.some((key) => object[key] !== undefined);
}

function required(value, name) {
  if (!value) {
    throw new TypeError(`${name} is required`);
  }
  return value;
}

function camelCase(value) {
  return value.replaceAll(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
}

function printHelp() {
  console.log(`Usage: npm run gateway:token -- <command> [options]

Commands:
  create --ref <ref> --actor <actor> --scope <scope> [--tenant <id>] [--project <id>] [--expires-at <iso>]
  list [--include-revoked false] [--limit 100]
  show --ref <ref>
  update --ref <ref> [--actor <actor>] [--scope <scope>] [--tenant <id>] [--project <id>] [--expires-at <iso|null>]
  rotate --ref <old-ref> --new-ref <new-ref> [--revoke-old] [--scope <scope>] [--expires-at <iso>]
  revoke --ref <ref> [--reason <text>]
  audit [--ref <ref>] [--limit 100]

Common options:
  --json
  --operator <actor>
  --postgres-url <url>
  --metadata-json '{"key":"value"}'

Create and rotate print tokenValue once. The raw value is never stored.`);
}
