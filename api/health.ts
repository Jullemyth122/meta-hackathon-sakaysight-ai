/**
 * GET /api/health -> reports which server features and credit protections are
 * active. Never echoes secrets or API keys.
 */

import { creditSaverEnabled, metaConfigured } from './_lib/meta.js';

export function GET(): Response {
  return Response.json({
    ok: true,
    assistant: metaConfigured(),
    creditSaver: creditSaverEnabled(),
    endpoints: [
      '/api/agent',
      '/api/assist',
      '/api/plan',
      '/api/transcribe',
      '/api/speak',
      '/api/health',
    ],
    features: [
      'commuter-eta-and-seat-forecast',
      'ltfrb-fare-calculator',
      'driver-dropoff-and-pickup-planner',
      'fcfs-multi-jeepney-conflict-resolution',
      'diesel-fuel-and-km-savings-calculator',
      'response-cache-60s-ttl',
      'same-site-and-rate-limits',
    ],
  });
}
