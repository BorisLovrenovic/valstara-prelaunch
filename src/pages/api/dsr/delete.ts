import type { APIRoute } from 'astro';
import { getConfig } from '../../../server/config.ts';
import { hashedIpPrefix } from '../../../server/ratelimit/ip-prefix.ts';
import { handleDsr } from '../../../server/dsr/runtime.ts';
export const POST: APIRoute = ({ request, clientAddress }) =>
  handleDsr(
    'delete',
    request,
    hashedIpPrefix(clientAddress, getConfig().ipPrefixPepper) ?? '',
  );
